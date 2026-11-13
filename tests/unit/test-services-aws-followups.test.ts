// Follow-ups to the all-services work: (1) the environment's cap on one backing's AWS services is the plan's, and a plan that is not wide never reaches a worker that would refuse it; (2) the usage record's optional
// `heavyFunctions` and the evidence sentences about them; (3) the digest fence of the test-environment edit.
import { describe, expect, it } from "vitest";
import {
  AWS_PLAN_SERVICES_MAX, IMPLICIT_COMPANY_ID, TEST_ENV_DEPENDENCY_LIMITS, TEST_ENV_EDIT_STALE_MESSAGE, TEST_SERVICES_AWS_ALL_SERVICES_FEATURE, TEST_SERVICES_AWS_USAGE_LIMITS, TEST_SERVICES_HEAVY_FUNCTION_REASONS,
  TestEnvBackingSchema, TestEnvEditBodySchema, TestEnvironmentBodySchema, TestServicesAwsUsageSchema, TestServicesUsageRecordSchema, awsHeavyFunctionEvidenceLine, awsHeavyFunctionEvidenceLines, awsPlanNeedsAllServices,
  projectMetaKey, testEnvDigest, type TaskDependencyPlan, type TestEnvironmentBody, type TestServicesUsageRecord,
} from "@rovara-code/contracts";
import { AWS_EMULATOR_SERVICES } from "../../packages/contracts/src/generated/aws-emulator-services.js";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";
import { documentOf, type TestEnvDeps } from "../../packages/core/src/core/test-env/deps.js";
import { clearEditedProposal, currentProposalDigest, proposeTestEnvironment, refuseStaleEdit, setEditedProposal } from "../../packages/core/src/core/test-env/environment.js";
import { featuresForTestPlan } from "../../packages/core/src/core/test-env/seam.js";
import { AWS_FIDELITY_ITEM_PREFIX, dependencyEvidenceOf } from "../../packages/core/src/core/proof/dependency-evidence.js";
import { createServiceRedactor, helperSecretValues } from "../../packages/worker/src/service-env.js";
import { newLocalAwsCredentials } from "../../packages/worker/src/service-helpers.js";
import { buildServiceUsageRecord, mergeAwsUsage, reduceHeavyFunctions } from "../../packages/worker/src/service-usage-record.js";

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
