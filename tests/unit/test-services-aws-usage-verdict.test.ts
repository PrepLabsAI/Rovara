// The broker judges the emulator's AWS usage. With Rovara local AWS in the plan, `dependency_usage` and the task evidence are NOT clean when the ledger facts are missing,
// unreadable or flooded, when the code called a service outside the plan, or when it called an operation the emulator does not offer. "Could not be checked" is never a pass.
import { describe, expect, it } from "vitest";
import { EvidencePackSchema, TEST_SERVICES_AWS_USAGE_WORDS, TestEnvironmentBodySchema, TestServicesAwsUsageSchema, testServicesAwsUsageVerdict, type TestServicesUsageRecord } from "@rovara-code/contracts";
import { AWS_USAGE_ITEM_ID, dependencyEvidenceOf } from "../../packages/core/src/core/proof/dependency-evidence.js";
import { dependencyStepsOf } from "../../packages/core/src/core/test-env/prove-from-setup-check.js";

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
