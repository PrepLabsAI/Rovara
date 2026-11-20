// The table of the AWS services Rovara local AWS serves (generated), and what is built on it: the plannable service keys, legacy ids, the plan's wire shape, the emulator tiers, the usage ledger, the worker feature and the
// engine pin. The generator itself is in tests/unit/aws-emulator-gen-service-table.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AWS_PLAN_SERVICES_MAX, awsEmulatorEvidenceLine, awsEmulatorEvidenceLines, awsEmulatorServiceRow, awsFidelityPercent, awsServiceKeyFromEndpointVariable, awsServicesForSigningName, checkEmulatorEngine, normaliseAwsLedgerName, normaliseAwsServiceKey } from "../../packages/contracts/src/aws-emulator-service-keys.js";
import {
  AWS_EMULATOR_ENGINE, AWS_EMULATOR_ENGINE_COMMIT, AWS_EMULATOR_ENGINE_VERSION, AWS_EMULATOR_SCORES_SHA256, AWS_EMULATOR_SERVICES, AWS_EMULATOR_SHARED_SIGNING_NAMES,
} from "../../packages/contracts/src/generated/aws-emulator-services.js";
import { EmulatorSchema, emulatorChoosable, emulatorServiceTier } from "../../packages/contracts/src/service-catalog.js";
import { SEEDED_AWS_SERVICES, TEST_SERVICES_AWS_ALL_SERVICES_FEATURE, TaskDependencyPlanSchema, awsPlanNeedsAllServices } from "../../packages/contracts/src/test-environment-wire.js";
import { TEST_SERVICES_AWS_USAGE_LIMITS, TestServicesAwsUsageSchema, testServicesAwsUsageVerdict, type TestServicesUsageRecord } from "../../packages/contracts/src/test-services-usage.js";
import { WORKER_INVOCATION_FEATURES } from "../../packages/contracts/src/protocol.js";
import { featuresForTestPlan } from "../../packages/broker/src/core/test-env/seam.js";

const rows = AWS_EMULATOR_SERVICES;
const byKey = (key: string) => awsEmulatorServiceRow(key)!;

describe("the generated table", () => {
  it("names the engine, its commit and the scores it was made from", () => {
    expect(AWS_EMULATOR_ENGINE).toBe("aws-emulator@1.0.385");
    expect(AWS_EMULATOR_ENGINE_VERSION).toBe("1.0.385");
    expect(AWS_EMULATOR_ENGINE_COMMIT).toMatch(/^[0-9a-f]{40}$/u);
    expect(AWS_EMULATOR_SCORES_SHA256).toMatch(/^[0-9a-f]{64}$/u);
    const text = readFileSync(new URL("../../packages/contracts/src/generated/aws-emulator-services.ts", import.meta.url), "utf8");
    expect(text.split("\n").slice(0, 6).join("\n")).toContain(`Engine: ${AWS_EMULATOR_ENGINE}`);
    expect(text.split("\n").slice(0, 6).join("\n")).toContain(AWS_EMULATOR_ENGINE_COMMIT);
    expect(text.split("\n").slice(0, 6).join("\n")).toContain(AWS_EMULATOR_SCORES_SHA256);
  });

  it("has one row per service, each key and each endpoint-variable name once", () => {
    expect(rows).toHaveLength(436);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    expect(new Set(rows.map((row) => row.envKey)).size).toBe(rows.length);
    expect(new Set(rows.map((row) => row.smithyId)).size).toBe(rows.length);
    for (const row of rows) {
      expect(row.key).toMatch(/^[a-z][a-z0-9-]{1,39}$/u);
      expect(row.envKey).toBe(row.key.toUpperCase().replace(/-/gu, "_"));
      expect(row.sdkId.toUpperCase().replace(/ /gu, "_")).toBe(row.envKey);
    }
    expect([...rows.map((row) => row.key)]).toEqual([...rows.map((row) => row.key)].sort());
  });

});

describe("service keys and legacy ids", () => {
  const LEGACY: Record<string, string> = {
    events: "eventbridge", stepfunctions: "sfn", states: "sfn", "cognito-idp": "cognito-identity-provider", logs: "cloudwatch-logs", cloudwatchlogs: "cloudwatch-logs",
    secretsmanager: "secrets-manager", dynamodbstreams: "dynamodb-streams", apigateway: "api-gateway", es: "elasticsearch-service", "opensearch-serverless": "opensearchserverless",
  };

  it("never lists a legacy id that is a key, or one id for two services", () => {
    const keys = new Set(rows.map((row) => row.key));
    const seen = new Set<string>();
    for (const row of rows) for (const alias of row.legacyKeys) {
      expect(keys.has(alias)).toBe(false);
      expect(seen.has(alias)).toBe(false);
      seen.add(alias);
    }
    expect(seen).toEqual(new Set(Object.keys(LEGACY)));
  });

});

const DIGEST = "a".repeat(64);
const plan = (aws: unknown, over: Record<string, unknown> = {}) => ({
  id: "aws-s3", name: "S3", kind: "object_store", family: "aws:s3", backing: "emulated", catalogId: "local-aws@r1", repository: "svc/local-aws", digest: DIGEST,
  config: {}, aliases: ["aws"], connect: [], seeds: [], reset: "fresh_per_round", aws, ...over,
});
const region = "us-east-1";

describe("the plan's AWS services", () => {
  it("parses an old plan of s3, sqs and dynamodb unchanged and writes it back the same", () => {
    const old = plan({ services: ["s3", "sqs", "dynamodb"], region });
    const parsed = TaskDependencyPlanSchema.parse(old);
    expect(parsed.aws).toEqual({ services: ["s3", "sqs", "dynamodb"], region });
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(JSON.parse(JSON.stringify(old)));
    expect(awsPlanNeedsAllServices(parsed.aws!.services)).toBe(false);
    expect([...SEEDED_AWS_SERVICES]).toEqual(["s3", "sqs", "dynamodb"]);
  });

  it("lists a service once, even when two spellings name it", () => {
    expect(TaskDependencyPlanSchema.safeParse(plan({ services: ["s3", "s3"], region })).success).toBe(false);
    expect(TaskDependencyPlanSchema.safeParse(plan({ services: ["s3", "eventbridge", "events"], region })).success).toBe(false);
  });

  it("allows at most 64 services, and at least one", () => {
    const keys = rows.map((row) => row.key).filter((key) => key !== "s3");
    expect(AWS_PLAN_SERVICES_MAX).toBe(64);
    expect(TaskDependencyPlanSchema.safeParse(plan({ services: ["s3", ...keys.slice(0, 63)], region })).success).toBe(true);
    expect(TaskDependencyPlanSchema.safeParse(plan({ services: ["s3", ...keys.slice(0, 64)], region })).success).toBe(false);
    expect(TaskDependencyPlanSchema.safeParse(plan({ services: [], region })).success).toBe(false);
    expect(TaskDependencyPlanSchema.safeParse(plan({ services: ["s3", "not-a-service"], region })).success).toBe(false);
  });

  it("sends a wide plan only to a worker that lists the all-services feature", () => {
    expect(TEST_SERVICES_AWS_ALL_SERVICES_FEATURE).toBe("task.testServices.aws.allServices.v1");
    expect(WORKER_INVOCATION_FEATURES).toContain(TEST_SERVICES_AWS_ALL_SERVICES_FEATURE);
    const narrow = [TaskDependencyPlanSchema.parse(plan({ services: ["s3", "sqs", "dynamodb"], region }))];
    const wide = [TaskDependencyPlanSchema.parse(plan({ services: ["s3", "sns"], region }))];
    expect(featuresForTestPlan(narrow)).not.toContain(TEST_SERVICES_AWS_ALL_SERVICES_FEATURE);
    expect(featuresForTestPlan(narrow)).toContain("task.testServices.aws.v1");
    expect(featuresForTestPlan(wide)).toEqual(expect.arrayContaining(["task.testServices.v1", "task.testServices.aws.v1", TEST_SERVICES_AWS_ALL_SERVICES_FEATURE]));
  });
});

describe("the emulator tiers", () => {
  const emulator = (services: Partial<Record<"supported" | "functions" | "model_endpoint_front" | "available", string[]>> = {}) =>
    EmulatorSchema.parse({ services: { supported: ["s3", "sqs", "dynamodb"], functions: ["lambda"], model_endpoint_front: [], ...services }, iamEnforced: false, storage: "memory" });

  it("lists only the overrides: every other service of the table is available", () => {
    const entry = emulator();
    expect(emulatorServiceTier(entry, "s3")).toBe("supported");
    expect(emulatorServiceTier(entry, "lambda")).toBe("functions");
    expect(emulatorServiceTier(entry, "sns")).toBe("available");
    expect(emulatorServiceTier(entry, "secrets-manager")).toBe("available");
    expect(emulatorServiceTier(entry, "secretsmanager")).toBe("available");
    expect(emulatorServiceTier(entry, "not-a-service")).toBeUndefined();
    expect(emulatorChoosable(entry, "sns")).toBe(false);
    expect(emulatorChoosable(entry, "s3")).toBe(true);
  });

  it("reads a legacy id and its key as one service", () => {
    const entry = emulator({ supported: ["s3", "secretsmanager", "events"] });
    expect(emulatorServiceTier(entry, "secrets-manager")).toBe("supported");
    expect(emulatorServiceTier(entry, "eventbridge")).toBe("supported");
    expect(EmulatorSchema.safeParse({ services: { supported: ["s3", "events"], functions: [], model_endpoint_front: [], available: ["eventbridge"] }, iamEnforced: false, storage: "memory" }).success).toBe(false);
  });

});

describe("the engine pin", () => {
  const entry = (engineVersion?: string) => ({ backing: "emulated", emulator: engineVersion === undefined ? {} : { engineVersion } });

  it("passes an entry that runs the table's engine, and a backing that is not the emulator", () => {
    expect(checkEmulatorEngine(entry(AWS_EMULATOR_ENGINE_VERSION))).toEqual({ ok: true });
    expect(checkEmulatorEngine({ backing: "local" })).toEqual({ ok: true });
  });

});

describe("an older-shaped catalog and the optional engine pin", () => {
  const entry = (engineVersion?: string) => ({ backing: "emulated", emulator: engineVersion === undefined ? {} : { engineVersion } });
  it("the optional check passes an entry with no version, passes the table's, and refuses a different one (the strict check still refuses no version)", () => {
    expect(checkEmulatorEngine(entry(), { pinned: "optional" })).toEqual({ ok: true });
    expect(checkEmulatorEngine(entry(AWS_EMULATOR_ENGINE_VERSION), { pinned: "optional" })).toEqual({ ok: true });
    expect(checkEmulatorEngine(entry("1.0.321"), { pinned: "optional" })).toMatchObject({ ok: false, reason: "engine_mismatch" });
    expect(checkEmulatorEngine(entry(), { pinned: "required" })).toMatchObject({ ok: false, reason: "engine_not_pinned" });
  });
});

describe("names the ledger and the SDKs use", () => {
  it("reads a ledger name as a key: a key, a legacy id, a signing name one service owns; anything else as it came", () => {
    expect(normaliseAwsLedgerName("s3")).toBe("s3");
    expect(normaliseAwsLedgerName("secretsmanager")).toBe("secrets-manager");
    expect(normaliseAwsLedgerName("monitoring")).toBe("cloudwatch");
    expect(normaliseAwsLedgerName("unknown")).toBe("unknown");
    // A signing name two services share names neither of them.
    expect(AWS_EMULATOR_SHARED_SIGNING_NAMES["appconfig"]).toBeDefined();
    expect(normaliseAwsLedgerName("appconfigdata")).toBe(normaliseAwsServiceKey("appconfigdata") ?? "appconfigdata");
  });
  it("looks a signing name up without the prototype chain", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) expect(awsServicesForSigningName(name)).toEqual([]);
    expect(awsServicesForSigningName("apigateway")).toEqual(["api-gateway", "apigatewayv2"]);
    expect(awsServiceKeyFromEndpointVariable("constructor")).toBeUndefined();
  });
});

describe("the evidence lines of an emulated run", () => {
  it("says what emulated each planned service and how far that matches AWS (the table's own score), or that it was not scored", () => {
    expect(awsFidelityPercent("s3")).toBe(Math.round(byKey("s3").behavioralOwnScore! * 100));
    expect(awsEmulatorEvidenceLine("sqs")).toBe(`sqs: Emulated by AWS Emulator ${AWS_EMULATOR_ENGINE_VERSION}, AWS fidelity score ${String(Math.round(byKey("sqs").behavioralOwnScore! * 100))}%`);
    const unscored = rows.find((row) => row.behavioralOwnScore === null)!;
    expect(awsEmulatorEvidenceLine(unscored.key)).toBe(`${unscored.key}: Emulated by AWS Emulator ${AWS_EMULATOR_ENGINE_VERSION}, AWS fidelity score: not scored`);
    expect(awsEmulatorEvidenceLine("nosuchservice")).toBeUndefined();
    expect(awsEmulatorEvidenceLine("secretsmanager")).toContain("secrets-manager: Emulated");
  });
  it("one line per planned service (once, a legacy spelling as its key), then the operations the run called that the emulator does not support", () => {
    const lines = awsEmulatorEvidenceLines(["s3", "secretsmanager", "secrets-manager", "nosuchservice"], [{ service: "s3", operation: "PutBucketReplication", count: 2 }, { service: "secretsmanager", operation: "RotateSecret", count: 1 }]);
    expect(lines).toHaveLength(4);
    expect(lines[2]).toBe("s3: operations AWS Emulator does not support, called by the tests: PutBucketReplication (2)");
    expect(lines[3]).toBe("secrets-manager: operations AWS Emulator does not support, called by the tests: RotateSecret (1)");
    expect(awsEmulatorEvidenceLines([])).toEqual([]);
  });
});

describe("the usage ledger", () => {
  const read = (services: Array<Record<string, unknown>>) => ({ ledger: "read", services, unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 });
  const record = (aws: unknown): TestServicesUsageRecord => ({ schemaVersion: 1, dependencies: [{ id: "aws-s3", started: true, healthy: true, startMs: 1, resetCount: 0 }], unknownCalls: { domains: [], otherCount: 0 }, aws } as TestServicesUsageRecord);

  it("names up to 64 services, and an old record of 24 or fewer parses unchanged", () => {
    expect(TEST_SERVICES_AWS_USAGE_LIMITS.services).toBe(64);
    const many = (count: number) => read(rows.slice(0, count).map((row) => ({ service: row.key, calls: 1, unsupported: 0 })));
    expect(TestServicesAwsUsageSchema.safeParse(many(64)).success).toBe(true);
    expect(TestServicesAwsUsageSchema.safeParse(many(65)).success).toBe(false);
    const old = read([{ service: "s3", calls: 6, unsupported: 0 }]);
    expect(TestServicesAwsUsageSchema.parse(old)).toEqual(old);
  });

  it("counts calls to a service the plan did not name, never more than the calls", () => {
    expect(TestServicesAwsUsageSchema.safeParse(read([{ service: "sns", calls: 3, unsupported: 0, outOfPlan: 3 }])).success).toBe(true);
    expect(TestServicesAwsUsageSchema.safeParse(read([{ service: "sns", calls: 3, unsupported: 0, outOfPlan: 4 }])).success).toBe(false);
    expect(TestServicesAwsUsageSchema.safeParse(read([{ service: "sns", calls: 3, unsupported: 0, outOfPlan: -1 }])).success).toBe(false);
  });

  it("judges a call outside the plan, whichever way the plan and the ledger spell the service", () => {
    expect(testServicesAwsUsageVerdict(record(read([{ service: "secretsmanager", calls: 1, unsupported: 0 }])), ["secrets-manager"])).toEqual({ ok: true });
    expect(testServicesAwsUsageVerdict(record(read([{ service: "secrets-manager", calls: 1, unsupported: 0 }])), ["secretsmanager"])).toEqual({ ok: true });
    expect(testServicesAwsUsageVerdict(record(read([{ service: "sns", calls: 1, unsupported: 0 }])), ["secrets-manager"])).toEqual({ ok: false, problem: "out_of_plan", services: ["sns"] });
    expect(testServicesAwsUsageVerdict(record(read([{ service: "s3", calls: 2, unsupported: 0, outOfPlan: 1 }])), ["s3"])).toEqual({ ok: false, problem: "out_of_plan", services: ["s3"] });
  });
});

describe("the browser-safe files", () => {
  it("import nothing from Node, and the generated table imports nothing at all", () => {
    const generated = readFileSync(new URL("../../packages/contracts/src/generated/aws-emulator-services.ts", import.meta.url), "utf8");
    const keys = readFileSync(new URL("../../packages/contracts/src/aws-emulator-service-keys.ts", import.meta.url), "utf8");
    expect(generated).not.toMatch(/^\s*import\s/mu);
    expect(generated).not.toMatch(/\brequire\(|node:|process\./u);
    expect([...keys.matchAll(/^import .* from "([^"]+)";/gmu)].map((match) => match[1])).toEqual(["zod", "./generated/aws-emulator-services.js"]);
    expect(keys).not.toMatch(/node:|\bprocess\./u);
  });

  it("keeps the operations that answer NotImplemented out of the table and out of the barrel", () => {
    const generated = readFileSync(new URL("../../packages/contracts/src/generated/aws-emulator-services.ts", import.meta.url), "utf8");
    const notImplemented = JSON.parse(readFileSync(new URL("../../packages/contracts/src/generated/aws-emulator-not-implemented.json", import.meta.url), "utf8")) as { services: Record<string, { notImplemented: string[]; unwired: string[] }> };
    expect(notImplemented.services["s3"]!.notImplemented).toEqual(["CreateBucketMetadataTableConfiguration", "DeleteBucketMetadataTableConfiguration", "GetBucketMetadataTableConfiguration", "WriteGetObjectResponse"]);
    expect(Object.values(notImplemented.services).reduce((total, entry) => total + entry.notImplemented.length, 0)).toBe(rows.reduce((total, row) => total + row.notImplementedCount, 0));
    expect(Object.values(notImplemented.services).reduce((total, entry) => total + entry.unwired.length, 0)).toBe(rows.reduce((total, row) => total + row.unwiredCount, 0));
    expect(generated).not.toEqual(["CreateBucketMetadataTableConfiguration", "DeleteBucketMetadataTableConfiguration", "GetBucketMetadataTableConfiguration", "WriteGetObjectResponse"]);
    expect(readFileSync(new URL("../../packages/contracts/src/index.ts", import.meta.url), "utf8")).not.toContain("not-implemented");
  });

});
