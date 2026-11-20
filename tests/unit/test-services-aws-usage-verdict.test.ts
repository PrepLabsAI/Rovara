// The broker judges the emulator's AWS usage. With Rovara local AWS in the plan, `dependency_usage` and the task evidence are NOT clean when the ledger facts are missing,
// unreadable or flooded, when the code called a service outside the plan, or when it called an operation the emulator does not offer. "Could not be checked" is never a pass.
import { describe, expect, it } from "vitest";
import { EvidencePackSchema, TEST_SERVICES_AWS_USAGE_WORDS, TestEnvironmentBodySchema, TestServicesAwsUsageSchema, testServicesAwsUsageVerdict, type TestServicesUsageRecord, AWS_PLAN_SERVICES_MAX, IMPLICIT_COMPANY_ID, TEST_ENV_DEPENDENCY_LIMITS, TEST_ENV_EDIT_STALE_MESSAGE, TEST_SERVICES_AWS_ALL_SERVICES_FEATURE, TEST_SERVICES_AWS_USAGE_LIMITS, TEST_SERVICES_HEAVY_FUNCTION_REASONS, TestEnvBackingSchema, TestEnvEditBodySchema, TestServicesUsageRecordSchema, awsHeavyFunctionEvidenceLine, awsHeavyFunctionEvidenceLines, awsPlanNeedsAllServices, projectMetaKey, testEnvDigest, type TaskDependencyPlan, type TestEnvironmentBody } from "@agentx/contracts";
import { AWS_USAGE_ITEM_ID, dependencyEvidenceOf, AWS_FIDELITY_ITEM_PREFIX } from "../../packages/broker/src/core/proof/dependency-evidence.js";
import { dependencyStepsOf } from "../../packages/broker/src/core/test-env/prove-from-setup-check.js";
import { AWS_EMULATOR_SERVICES } from "../../packages/contracts/src/generated/aws-emulator-services.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { documentOf, type TestEnvDeps } from "../../packages/broker/src/core/test-env/deps.js";
import { clearEditedProposal, currentProposalDigest, proposeTestEnvironment, refuseStaleEdit, setEditedProposal } from "../../packages/broker/src/core/test-env/environment.js";
import { featuresForTestPlan } from "../../packages/broker/src/core/test-env/seam.js";
import { createServiceRedactor, helperSecretValues } from "../../packages/worker/src/service-env.js";
import { newLocalAwsCredentials } from "../../packages/worker/src/service-helpers.js";
import { buildServiceUsageRecord, mergeAwsUsage, reduceHeavyFunctions } from "../../packages/worker/src/service-usage-record.js";

const cmd = (executable: string, args: string[] = [], cwd = "service") => ({ cwd, executable, args, timeoutSeconds: 600 });
const emulatedDependency = (service: string) => ({
  id: `aws-${service}`, name: service.toUpperCase(), kind: "object_store", family: `aws:${service}`, found: [{ path: "template.yaml", line: 3 }], usedBy: ["integration"],
  backing: { kind: "emulated", catalogId: "local-aws@r1", awsServices: [service], region: "us-east-1" }, connect: { env: [], hostAliases: service === "s3" ? ["aws"] : [] }, seeds: [], reset: "fresh_per_round",
});
const body = (services: string[]) => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "service", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }], roundBudgetMin: 30,
  selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, dependencies: services.map(emulatedDependency),
});
type Aws = NonNullable<TestServicesUsageRecord["aws"]>;
const clean: Aws = { ledger: "read", services: [{ service: "s3", calls: 6, unsupported: 0 }, { service: "sqs", calls: 2, unsupported: 0 }], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 };
const record = (aws: Aws | undefined, services = ["s3", "sqs", "dynamodb"]): TestServicesUsageRecord => ({
  schemaVersion: 1, dependencies: services.map((service) => ({ id: `aws-${service}`, started: true, healthy: true, startMs: 100, resetCount: 0 })), unknownCalls: { domains: [], otherCount: 0 }, ...(aws === undefined ? {} : { aws }),
});
const PLANNED = ["s3", "sqs", "dynamodb"];

const cases: Array<[string, Aws | undefined, string, string[]]> = [
  ["no ledger facts at all", undefined, "not_checked", []],
  ["an unreadable ledger", { ledger: "unreadable", services: [], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 }, "not_checked", []],
  ["a flooded ledger", { ledger: "flooded", services: [], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 }, "flooded", []],
  ["a call to SNS, which is not in the plan", { ...clean, services: [...clean.services, { service: "sns", calls: 1, unsupported: 0 }] }, "out_of_plan", ["sns"]],
  ["calls to a service that is not shown", { ...clean, otherCalls: 1 }, "out_of_plan", []],
  ["an unsupported operation, named", { ...clean, services: [{ service: "s3", calls: 6, unsupported: 1 }], unsupportedOperations: [{ service: "s3", operation: "PutBucketReplication", count: 1 }] }, "unsupported", []],
  ["an unsupported operation, not named", { ...clean, otherUnsupported: 1 }, "unsupported", []],
  ["unsupported calls counted on a service", { ...clean, services: [{ service: "s3", calls: 6, unsupported: 2 }] }, "unsupported", []],
];

describe("testServicesAwsUsageVerdict", () => {
  it("is clean for a read ledger with only planned services and no unsupported operation", () => {
    expect(testServicesAwsUsageVerdict(record(clean), PLANNED)).toEqual({ ok: true });
    expect(testServicesAwsUsageVerdict(record({ ...clean, services: [] }), PLANNED)).toEqual({ ok: true });
  });
  for (const [label, aws, problem, services] of cases) {
    it(`is not clean for ${label}`, () => {
      expect(testServicesAwsUsageVerdict(record(aws), PLANNED)).toEqual({ ok: false, problem, services });
    });
  }
  it("no record at all is 'could not be checked'; the planned services are the broker's (a service not planned is out of the plan even if the emulator served it)", () => {
    expect(testServicesAwsUsageVerdict(undefined, PLANNED)).toMatchObject({ ok: false, problem: "not_checked" });
    expect(testServicesAwsUsageVerdict(record(clean), ["s3"])).toEqual({ ok: false, problem: "out_of_plan", services: ["sqs"] });
  });
  it("has fixed words for each problem, and the flooded state is a contract value that says nothing else", () => {
    expect(Object.keys(TEST_SERVICES_AWS_USAGE_WORDS).sort()).toEqual(["flooded", "not_checked", "out_of_plan", "unsupported"]);
    expect(TestServicesAwsUsageSchema.safeParse({ ledger: "flooded", services: [], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 }).success).toBe(true);
    expect(TestServicesAwsUsageSchema.safeParse({ ledger: "flooded", services: [{ service: "s3", calls: 1, unsupported: 0 }], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 }).success).toBe(false);
  });
});

describe("Prove: dependency_usage", () => {
  const steps = (aws: Aws | undefined, services = PLANNED) => {
    const result = dependencyStepsOf(body(services), record(aws, services));
    if (result === "not_checked") throw new Error("not checked");
    return Object.fromEntries(result.map((step) => [step.step, step]));
  };
  it("passes for a clean ledger", () => {
    expect(steps(clean).dependency_usage).toMatchObject({ status: "passed" });
    expect(steps(clean).dependencies).toMatchObject({ status: "passed" });
  });
  for (const [label, aws] of cases) {
    it(`FAILS for ${label}, with the fixed failure word`, () => {
      expect(steps(aws).dependency_usage).toMatchObject({ status: "failed", failure: "dependency_unexpected_call" });
      // The start step is about the start and is not changed by it.
      expect(steps(aws).dependencies).toMatchObject({ status: "passed" });
    });
  }
  it("a call to a service that IS in the plan of another entry is fine; one outside the union is not", () => {
    expect(steps({ ...clean, services: [{ service: "dynamodb", calls: 1, unsupported: 0 }] }).dependency_usage).toMatchObject({ status: "passed" });
    expect(steps({ ...clean, services: [{ service: "sqs", calls: 1, unsupported: 0 }] }, ["s3"]).dependency_usage).toMatchObject({ status: "failed" });
  });
  it("an environment without an emulator is judged as before (an aws field on its record changes nothing)", () => {
    const plain = TestEnvironmentBodySchema.parse({ ...body([]), dependencies: [{ ...emulatedDependency("s3"), id: "postgres", name: "Postgres", family: "postgres", backing: { kind: "local", catalogId: "postgres@16", config: {} }, connect: { env: [], hostAliases: ["postgres"] } }] });
    const result = dependencyStepsOf(plain, { schemaVersion: 1, dependencies: [{ id: "postgres", started: true, healthy: true, startMs: 5, resetCount: 0 }], unknownCalls: { domains: [], otherCount: 0 } });
    expect(result).not.toBe("not_checked");
    expect((result as Array<{ step: string; status: string }>).find((step) => step.step === "dependency_usage")?.status).toBe("passed");
  });
});

describe("task evidence", () => {
  const pinned = PLANNED.map((service) => ({ id: `aws-${service}`, name: service.toUpperCase(), backing: "emulated" as const, awsServices: [service] }));
  const itemOf = (aws: Aws | undefined) => dependencyEvidenceOf(pinned, record(aws)).notTested.find((item) => item.id === AWS_USAGE_ITEM_ID);
  it("a clean run has no AWS usage item", () => {
    expect(itemOf(clean)).toBeUndefined();
  });
  it("says plainly that the usage could not be checked, in fixed words", () => {
    expect(itemOf(undefined)?.text).toBe("AWS usage could not be checked");
    expect(itemOf({ ledger: "unreadable", services: [], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 })?.text).toBe("AWS usage could not be checked");
    expect(itemOf({ ledger: "flooded", services: [], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 })?.text).toBe("AWS usage could not be checked: the code made too many different AWS calls");
  });
  it("names the service outside the plan, and says an operation is unsupported", () => {
    expect(itemOf({ ...clean, services: [...clean.services, { service: "sns", calls: 1, unsupported: 0 }] })?.text).toBe("The code called AWS services that are not in the plan: sns");
    expect(itemOf({ ...clean, otherUnsupported: 1 })?.text).toBe("The code called AWS operations that Rovara local AWS does not support");
  });
  it("is a not-tested item the pack accepts (so the pull request and the Evidence tab show it), and it is absent for a run with no emulator", () => {
    const item = itemOf(undefined)!;
    expect(item).toMatchObject({ kind: "environment", id: "aws-usage" });
    expect(EvidencePackSchema.shape.notTested.safeParse([item]).success).toBe(true);
    const local = dependencyEvidenceOf([{ id: "postgres", name: "Postgres", backing: "local" }], { schemaVersion: 1, dependencies: [{ id: "postgres", started: true, healthy: true, startMs: 1, resetCount: 0 }], unknownCalls: { domains: [], otherCount: 0 } });
    expect(local.notTested.find((entry) => entry.id === AWS_USAGE_ITEM_ID)).toBeUndefined();
  });
});

describe("AWS service caps, heavy functions and edit digests", () => {
  const KEYS = AWS_EMULATOR_SERVICES.map((row) => row.key);
  const cmd = (executable: string, args: string[] = []) => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
  const backing = (awsServices: string[]) => ({ kind: "emulated", catalogId: "local-aws@r1", awsServices, region: "us-east-1" });
  const environment = (services: string[], over: Record<string, unknown> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
    tier: "sandbox", repos: [{ repositoryId: "service", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }], roundBudgetMin: 30,
    selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
    prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
    dependencies: [{ id: "aws", name: "AWS", kind: "cloud_api", family: `aws:${services[0]!}`, found: [{ path: "template.yaml", line: 3 }], usedBy: ["integration"], backing: backing(services), connect: { env: [], hostAliases: ["aws"] }, seeds: [], reset: "fresh_per_round" }],
    ...over,
  });

  describe("the cap on the AWS services of one backing", () => {
    it("is the plan's cap: 64 services parse, 65 are refused, and a body stored with up to 24 still parses", () => {
      expect(TEST_ENV_DEPENDENCY_LIMITS.awsServices).toBe(AWS_PLAN_SERVICES_MAX);
      expect(TestEnvBackingSchema.safeParse(backing(KEYS.slice(0, 64))).success).toBe(true);
      expect(TestEnvBackingSchema.safeParse(backing([...KEYS.slice(0, 64), "zzz"])).success).toBe(false);
      expect(TestEnvBackingSchema.safeParse(backing(KEYS.slice(0, 24))).success).toBe(true);
      expect(TestEnvBackingSchema.safeParse(backing(KEYS.slice(0, 1))).success).toBe(true);
    });
    it("is the same in the environment body and in an edit of it, and still lists a service once", () => {
      expect(TestEnvironmentBodySchema.safeParse(environment(KEYS.slice(0, 64))).success).toBe(true);
      expect(TestEnvEditBodySchema.safeParse({ environment: environment(KEYS.slice(0, 40)) }).success).toBe(true);
      expect(() => environment([...KEYS.slice(0, 3), KEYS[0]!])).toThrow();
    });
    it("keeps a plan that is not wide inside what a worker without the feature accepts: more than the three seeded names, or any other service, needs the feature", () => {
      expect(awsPlanNeedsAllServices(["s3", "sqs", "dynamodb"])).toBe(false);
      expect(awsPlanNeedsAllServices(["s3"])).toBe(false);
      expect(awsPlanNeedsAllServices(["s3", "sqs", "dynamodb", "s3"])).toBe(true);
      expect(awsPlanNeedsAllServices(Array.from({ length: 25 }, () => "s3"))).toBe(true);
      expect(awsPlanNeedsAllServices(["s3", "sns"])).toBe(true);
      expect(awsPlanNeedsAllServices(KEYS.slice(0, 40))).toBe(true);
    });
    it("the broker adds the feature to the step of a plan of 40 services and of 25 repeated names, and not to a plan of the three", () => {
      const plan = (services: string[]): TaskDependencyPlan => ({ id: "aws", name: "AWS", kind: "cloud_api", family: "aws:s3", backing: "emulated", aws: { services, region: "us-east-1" }, seeds: [] }) as unknown as TaskDependencyPlan;
      expect(featuresForTestPlan([plan(KEYS.slice(0, 40))])).toContain(TEST_SERVICES_AWS_ALL_SERVICES_FEATURE);
      expect(featuresForTestPlan([plan(Array.from({ length: 25 }, () => "s3"))])).toContain(TEST_SERVICES_AWS_ALL_SERVICES_FEATURE);
      expect(featuresForTestPlan([plan(["s3", "sqs", "dynamodb"])])).not.toContain(TEST_SERVICES_AWS_ALL_SERVICES_FEATURE);
    });
  });

  describe("heavy functions in the usage record", () => {
    const read = (extra: Record<string, unknown> = {}) => ({ ledger: "read", services: [{ service: "lambda", calls: 2, unsupported: 0 }], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0, ...extra });
    it("an old record (no field) still parses, and a record with the field parses with a fixed reason", () => {
      expect(TestServicesAwsUsageSchema.safeParse(read()).success).toBe(true);
      for (const reason of TEST_SERVICES_HEAVY_FUNCTION_REASONS) expect(TestServicesAwsUsageSchema.safeParse(read({ heavyFunctions: [{ name: "order-handler_1", reason }] })).success).toBe(true);
      expect(TEST_SERVICES_HEAVY_FUNCTION_REASONS).toEqual(["image", "runtime", "native-code", "x86-native", "unchecked", "timeout-over-28s"]);
    });
    it("refuses a bad name, an unknown reason, an extra key, more than 16, a function listed twice, and a list on a ledger that was not read", () => {
      const parse = (heavyFunctions: unknown[], over: Record<string, unknown> = {}) => TestServicesAwsUsageSchema.safeParse(read({ heavyFunctions, ...over })).success;
      expect(parse([{ name: "has space", reason: "image" }])).toBe(false);
      expect(parse([{ name: "a".repeat(65), reason: "image" }])).toBe(false);
      expect(parse([{ name: "payments-prod-process-order-handler-with-a-long-name-01234567", reason: "image" }])).toBe(true);
      expect(parse([{ name: "a".repeat(40), reason: "image" }])).toBe(false);
      expect(parse([{ name: ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""), reason: "image" }])).toBe(false);
      expect(parse([{ name: "fn.v1", reason: "image" }])).toBe(false);
      expect(parse([{ name: "fn", reason: "slow" }])).toBe(false);
      expect(parse([{ name: "fn", reason: "image", detail: "x" }])).toBe(false);
      expect(parse(Array.from({ length: 16 }, (_, index) => ({ name: `fn${String(index)}`, reason: "image" })))).toBe(true);
      expect(parse(Array.from({ length: 17 }, (_, index) => ({ name: `fn${String(index)}`, reason: "image" })))).toBe(false);
      expect(parse([{ name: "fn", reason: "image" }, { name: "fn", reason: "runtime" }])).toBe(false);
      expect(parse([{ name: "fn", reason: "image" }], { ledger: "unreadable", services: [], otherCalls: 0 })).toBe(false);
      expect(TEST_SERVICES_AWS_USAGE_LIMITS.heavyFunctions).toBe(16);
    });
    it("words the evidence: not run locally while there is no runner, ran in the runner once there is one", () => {
      expect(awsHeavyFunctionEvidenceLine({ name: "order-handler", reason: "image" })).toBe("Lambda function order-handler was not run locally (it is a container image); the function runner is not available yet");
      expect(awsHeavyFunctionEvidenceLine({ name: "order-handler", reason: "timeout-over-28s" }, { runnerAvailable: false })).toBe("Lambda function order-handler was not run locally (its timeout is over 28 seconds); the function runner is not available yet");
      expect(awsHeavyFunctionEvidenceLine({ name: "order-handler", reason: "x86-native" }, { runnerAvailable: true })).toBe("Lambda function order-handler ran in the Rovara function runner (it uses x86-only native code)");
      const usage = TestServicesAwsUsageSchema.parse(read({ heavyFunctions: [{ name: "a", reason: "runtime" }, { name: "b", reason: "unchecked" }] }));
      expect(awsHeavyFunctionEvidenceLines(usage)).toHaveLength(2);
      expect(awsHeavyFunctionEvidenceLines(TestServicesAwsUsageSchema.parse(read()))).toEqual([]);
      expect(awsHeavyFunctionEvidenceLines(undefined)).toEqual([]);
    });
    it("the task evidence carries the sentences, as not-tested items the broker names with the fidelity items", () => {
      const aws = TestServicesAwsUsageSchema.parse(read({ heavyFunctions: [{ name: "order-handler", reason: "image" }] }));
      const record: TestServicesUsageRecord = { schemaVersion: 1, dependencies: [{ id: "aws-lambda", started: true, healthy: true, startMs: 5, resetCount: 0 }], unknownCalls: { domains: [], otherCount: 0 }, aws };
      expect(TestServicesUsageRecordSchema.safeParse(record).success).toBe(true);
      const evidence = dependencyEvidenceOf([{ id: "aws-lambda", name: "Lambda", backing: "emulated", awsServices: ["lambda"] }], record);
      const texts = evidence.notTested.filter((item) => item.id.startsWith(AWS_FIDELITY_ITEM_PREFIX)).map((item) => item.text);
      expect(texts).toContain("Lambda function order-handler was not run locally (it is a container image); the function runner is not available yet");
      const without = dependencyEvidenceOf([{ id: "aws-lambda", name: "Lambda", backing: "emulated", awsServices: ["lambda"] }], { ...record, aws: read() as unknown as TestServicesUsageRecord["aws"] });
      expect(without.notTested.some((item) => item.text.includes("Lambda function"))).toBe(false);
    });

    const credentials = newLocalAwsCredentials();
    const redactor = createServiceRedactor(helperSecretValues([{ credentials }]));
    const ledger = { services: [{ service: "lambda", calls: 3, unsupported: 0, errors: 0, operations: [] }] };
    const heavy = [{ name: "order-handler", reason: "image" }, { name: "order-handler", reason: "runtime" }, { name: "bad name", reason: "image" }, { name: "x-native", reason: "x86-native" }] as const;
    const build = (awsWide: boolean | undefined) => buildServiceUsageRecord({ planned: [], redactor, emulator: () => Promise.resolve(ledger), heavyFunctions: heavy, ...(awsWide === undefined ? {} : { awsWide }) });
    it("only a worker with the all-services feature writes them: the wide record has them (a name once, bad names dropped), the narrow one never does", async () => {
      const wide = await build(true);
      expect(wide.aws?.heavyFunctions).toEqual([{ name: "order-handler", reason: "image" }, { name: "x-native", reason: "x86-native" }]);
      expect(TestServicesUsageRecordSchema.parse(wide)).toEqual(wide);
      for (const narrow of [await build(false), await build(undefined)]) {
        expect(narrow.aws).toBeDefined();
        expect("heavyFunctions" in narrow.aws!).toBe(false);
      }
    });
    it("a ledger that could not be read carries none, and the list is cut at 16, and a name the redactor would change is left out", async () => {
      const unreadable = await buildServiceUsageRecord({ planned: [], redactor, emulator: () => Promise.reject(new Error("down")), heavyFunctions: heavy, awsWide: true });
      expect(unreadable.aws).toEqual({ ledger: "unreadable", services: [], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 });
      expect(reduceHeavyFunctions(Array.from({ length: 30 }, (_, index) => ({ name: `fn${String(index)}`, reason: "image" })), redactor)).toHaveLength(16);
      expect(reduceHeavyFunctions([{ name: credentials.password, reason: "image" }], redactor)).toEqual([]);
    });
    it("merges the rounds' functions (a function once) when wide, and drops them when narrow", () => {
      const a = TestServicesAwsUsageSchema.parse(read({ heavyFunctions: [{ name: "one", reason: "image" }] }));
      const b = TestServicesAwsUsageSchema.parse(read({ heavyFunctions: [{ name: "one", reason: "image" }, { name: "two", reason: "runtime" }] }));
      expect(mergeAwsUsage(a, b, true)?.heavyFunctions).toEqual([{ name: "one", reason: "image" }, { name: "two", reason: "runtime" }]);
      expect(mergeAwsUsage(a, b, false) && "heavyFunctions" in mergeAwsUsage(a, b, false)!).toBe(false);
    });
  });

  describe("the digest fence of an edit", () => {
    const ORG = IMPLICIT_COMPANY_ID;
    const PROJECT = "partner-service";
    const world = () => {
      const store = new MemoryDocumentStore();
      const clock = { now: Date.UTC(2026, 10, 12, 10, 0, 0) };
      void store.put({ item: { ...projectMetaKey(ORG, PROJECT), status: "active" } });
      const deps: TestEnvDeps = { store, now: () => clock.now };
      return { deps, clock };
    };
    const body = (seed: number) => environment(["s3"], { dependencies: [], data: { seeds: [], generator: "faker_seeded", seed } });
    const propose = (w: ReturnType<typeof world>, seed: number) => proposeTestEnvironment(w.deps, { orgId: ORG, project: PROJECT, proposedBy: "owner", body: body(seed) });

    it("takes an optional digest in the edit body and still takes the body alone", () => {
      const digest = "a".repeat(64);
      expect(TestEnvEditBodySchema.safeParse({ environment: body(1) }).success).toBe(true);
      expect(TestEnvEditBodySchema.safeParse({ environment: body(1), digest }).success).toBe(true);
      expect(TestEnvEditBodySchema.safeParse({ environment: body(1), digest: "nope" }).success).toBe(false);
      expect(TestEnvEditBodySchema.safeParse({ environment: body(1), other: 1 }).success).toBe(false);
    });
    it("lets an edit through with no digest, or with the digest of the proposal the project holds", async () => {
      const w = world();
      const first = await propose(w, 1);
      await expect(refuseStaleEdit(w.deps, { orgId: ORG, project: PROJECT, digest: undefined })).resolves.toBeUndefined();
      await expect(refuseStaleEdit(w.deps, { orgId: ORG, project: PROJECT, digest: first.digest })).resolves.toBeUndefined();
    });
    it("refuses a stale edit with CHANGE_STALE and the fixed sentence, which names no digest", async () => {
      const w = world();
      const first = await propose(w, 1);
      w.clock.now += 1_000;
      const second = await propose(w, 2);
      expect(second.digest).not.toBe(first.digest);
      expect(await currentProposalDigest(w.deps, ORG, PROJECT)).toBe(second.digest);
      const refused = await refuseStaleEdit(w.deps, { orgId: ORG, project: PROJECT, digest: first.digest }).then(() => undefined, (error: unknown) => error as Error & { code?: string });
      expect(refused).toBeDefined();
      expect(refused?.code).toBe("CHANGE_STALE");
      expect(refused?.message).toContain(TEST_ENV_EDIT_STALE_MESSAGE);
      expect(refused?.message).not.toContain(first.digest);
      expect(refused?.message).not.toContain(second.digest);
      await expect(refuseStaleEdit(w.deps, { orgId: ORG, project: PROJECT, digest: second.digest })).resolves.toBeUndefined();
    });
    it("follows the owner's edited proposal, and refuses an edit of a proposal that is gone", async () => {
      const w = world();
      const first = await propose(w, 1);
      w.clock.now += 1_000;
      const edited = await propose(w, 3);
      await setEditedProposal(w.deps, { orgId: ORG, project: PROJECT, digest: first.digest, editedBy: "owner" });
      expect(await currentProposalDigest(w.deps, ORG, PROJECT)).toBe(first.digest);
      await expect(refuseStaleEdit(w.deps, { orgId: ORG, project: PROJECT, digest: edited.digest })).rejects.toMatchObject({ code: "CHANGE_STALE" });
      await clearEditedProposal(w.deps, ORG, PROJECT);
      await expect(refuseStaleEdit(w.deps, { orgId: ORG, project: PROJECT, digest: edited.digest })).resolves.toBeUndefined();
      await expect(refuseStaleEdit(w.deps, { orgId: ORG, project: PROJECT, digest: testEnvDigest(body(9)) })).rejects.toMatchObject({ code: "CHANGE_STALE" });
      // With nothing stored, a digest has nothing to match.
      const empty = world();
      await expect(refuseStaleEdit(empty.deps, { orgId: ORG, project: PROJECT, digest: "b".repeat(64) })).rejects.toMatchObject({ code: "CHANGE_STALE" });
      void documentOf;
    });
  });
});

