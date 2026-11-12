// The table of the AWS services Rovara local AWS serves (generated), and what is built on it: the plannable service keys, legacy ids, the plan's wire shape, the emulator tiers, the usage ledger, the worker feature and the
// engine pin. The generator itself is in tests/unit/aws-emulator-gen-service-table.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AWS_PLAN_SERVICES_MAX, AwsPlanServiceSchema, awsEmulatorEvidenceLine, awsEmulatorEvidenceLines, awsEmulatorServiceRow, awsFidelityPercent, awsServiceKeyFromEndpointVariable, awsServicesForSigningName, checkEmulatorEngine, normaliseAwsLedgerName, normaliseAwsServiceKey,
} from "../../packages/contracts/src/aws-emulator-service-keys.js";
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
    expect(AWS_EMULATOR_ENGINE).toBe("aws-emulator@1.0.337");
    expect(AWS_EMULATOR_ENGINE_VERSION).toBe("1.0.337");
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

  it("agrees with the SDK ids it is derived from", () => {
    const expected: Record<string, [string, string]> = {
      s3: ["S3", "AWS_ENDPOINT_URL_S3"], sqs: ["SQS", "AWS_ENDPOINT_URL_SQS"], dynamodb: ["DynamoDB", "AWS_ENDPOINT_URL_DYNAMODB"], "secrets-manager": ["Secrets Manager", "AWS_ENDPOINT_URL_SECRETS_MANAGER"],
      sfn: ["SFN", "AWS_ENDPOINT_URL_SFN"], eventbridge: ["EventBridge", "AWS_ENDPOINT_URL_EVENTBRIDGE"], "cognito-identity-provider": ["Cognito Identity Provider", "AWS_ENDPOINT_URL_COGNITO_IDENTITY_PROVIDER"],
      "cloudwatch-logs": ["CloudWatch Logs", "AWS_ENDPOINT_URL_CLOUDWATCH_LOGS"], "dynamodb-streams": ["DynamoDB Streams", "AWS_ENDPOINT_URL_DYNAMODB_STREAMS"],
    };
    for (const [key, [sdkId, variable]] of Object.entries(expected)) {
      expect(byKey(key).sdkId).toBe(sdkId);
      expect(`AWS_ENDPOINT_URL_${byKey(key).envKey}`).toBe(variable);
    }
  });

  it("derives the wire columns the models carry", () => {
    expect(byKey("sqs")).toMatchObject({ signingName: "sqs", protocols: ["awsJson1_0", "awsQueryCompatible"], targetPrefix: "AmazonSQS", queryVersion: null });
    expect(byKey("dynamodb")).toMatchObject({ signingName: "dynamodb", targetPrefix: "DynamoDB_20120810", queryVersion: null });
    expect(byKey("sns")).toMatchObject({ protocols: ["awsQuery"], targetPrefix: null, queryVersion: "2010-03-31" });
    expect(byKey("s3")).toMatchObject({ protocols: ["restXml"], targetPrefix: null, queryVersion: null });
    expect(byKey("secrets-manager")).toMatchObject({ signingName: "secretsmanager", targetPrefix: "secretsmanager" });
    expect(byKey("sfn")).toMatchObject({ signingName: "states", boto3Name: "stepfunctions", jsPackage: "@aws-sdk/client-sfn", goPackage: "github.com/aws/aws-sdk-go-v2/service/sfn", javaPackage: "software.amazon.awssdk.services.sfn" });
    expect(byKey("cloudwatch-logs")).toMatchObject({ boto3Name: "logs", jsPackage: "@aws-sdk/client-cloudwatch-logs", goPackage: "github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs" });
    for (const row of rows) {
      expect(row.opCount).toBeGreaterThan(0);
      expect(row.notImplementedCount + row.unwiredCount).toBeLessThanOrEqual(row.opCount);
    }
  });

  it("shares signing names between services, and two services have none", () => {
    const groups = new Map<string, string[]>();
    for (const row of rows) if (row.signingName !== null) groups.set(row.signingName, [...(groups.get(row.signingName) ?? []), row.key]);
    const shared = [...groups].filter(([, keys]) => keys.length > 1);
    expect(shared).toHaveLength(40);
    expect(shared.reduce((total, [, keys]) => total + keys.length, 0)).toBe(112);
    expect(Object.keys(AWS_EMULATOR_SHARED_SIGNING_NAMES).sort()).toEqual(shared.map(([name]) => name).sort());
    for (const [name, keys] of shared) expect([...AWS_EMULATOR_SHARED_SIGNING_NAMES[name]!].sort()).toEqual(keys.sort());
    for (const [name, count] of Object.entries({ sagemaker: 9, bedrock: 6, lambda: 4, events: 3, "execute-api": 2 })) expect(groups.get(name)).toHaveLength(count);
    expect(rows.filter((row) => row.signingName === null).map((row) => row.key)).toEqual(["account-access-runtime", "codecatalyst"]);
    expect(awsServicesForSigningName("events")).toEqual(["cloudwatch-events", "eventbridge", "eventbridgev2"]);
    expect(awsServicesForSigningName("s3")).toHaveLength(2);
    expect(awsServicesForSigningName("not-a-signing-name")).toEqual([]);
  });

  it("scores a service by the units that name it, and the figures are fractions", () => {
    for (const row of rows) {
      for (const score of [row.behavioralScore, row.wireScore, row.behavioralOwnScore]) if (score !== null) { expect(score).toBeGreaterThanOrEqual(0); expect(score).toBeLessThanOrEqual(1); }
      expect(row.behavioralScore === null).toBe(row.behavioralUnits === 0);
      expect(row.wireScore === null).toBe(row.wireUnits === 0);
      expect(row.behavioralOwnScore === null).toBe(row.behavioralOwnUnits === 0);
      expect(row.behavioralOwnUnits).toBeLessThanOrEqual(row.behavioralUnits);
    }
    expect(rows.filter((row) => row.behavioralScore !== null)).toHaveLength(352);
    // The units that name one service alone are the figure comparable to a per-suite score.
    expect(byKey("s3").behavioralOwnScore).toBeCloseTo(0.866, 3);
    expect(byKey("sqs").behavioralOwnScore).toBeCloseTo(0.935, 3);
    expect(byKey("s3").behavioralScore!).toBeLessThan(byKey("s3").behavioralOwnScore!);
  });
});

describe("service keys and legacy ids", () => {
  const LEGACY: Record<string, string> = {
    events: "eventbridge", stepfunctions: "sfn", states: "sfn", "cognito-idp": "cognito-identity-provider", logs: "cloudwatch-logs", cloudwatchlogs: "cloudwatch-logs",
    secretsmanager: "secrets-manager", dynamodbstreams: "dynamodb-streams", apigateway: "api-gateway", es: "elasticsearch-service", "opensearch-serverless": "opensearchserverless",
  };
  // Ids older code uses that are keys already.
  const SAME = ["s3", "sqs", "dynamodb", "sns", "sts", "ssm", "kms", "lambda", "kinesis", "iam", "sagemaker", "sagemaker-runtime", "bedrock-runtime", "apigatewayv2", "eventbridgev2"];

  it("reads every legacy id as its key, and a key as itself", () => {
    for (const [legacy, key] of Object.entries(LEGACY)) {
      expect(normaliseAwsServiceKey(legacy)).toBe(key);
      expect(byKey(key).legacyKeys).toContain(legacy);
    }
    for (const id of SAME) expect(normaliseAwsServiceKey(id)).toBe(id);
    for (const row of rows) expect(normaliseAwsServiceKey(row.key)).toBe(row.key);
  });

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

  it("refuses an id the table does not know", () => {
    for (const id of ["", "S3", "not-a-service", "s3 ", "__proto__", "constructor", "toString"]) expect(normaliseAwsServiceKey(id)).toBeUndefined();
    expect(AwsPlanServiceSchema.safeParse("not-a-service").success).toBe(false);
    expect(AwsPlanServiceSchema.safeParse("S3").success).toBe(false);
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

  it("parses a plan of any service of the table, and round-trips it", () => {
    const wide = plan({ services: ["s3", "secrets-manager", "sfn", "eventbridge", "cognito-identity-provider"], region });
    const parsed = TaskDependencyPlanSchema.parse(wide);
    expect(TaskDependencyPlanSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(awsPlanNeedsAllServices(parsed.aws!.services)).toBe(true);
  });

  it("turns a legacy id into its key on parse, and writes the key", () => {
    const parsed = TaskDependencyPlanSchema.parse(plan({ services: ["s3", "secretsmanager", "events", "cognito-idp"], region }));
    expect(parsed.aws!.services).toEqual(["s3", "secrets-manager", "eventbridge", "cognito-identity-provider"]);
    expect(JSON.stringify(parsed)).not.toContain("secretsmanager");
    expect(awsPlanNeedsAllServices(["secretsmanager"])).toBe(true);
    expect(awsPlanNeedsAllServices(["s3", "dynamodb"])).toBe(false);
  });

  it("reads the family of a legacy id as its key", () => {
    expect(TaskDependencyPlanSchema.safeParse(plan({ services: ["secrets-manager"], region }, { family: "aws:secretsmanager" })).success).toBe(true);
    expect(TaskDependencyPlanSchema.safeParse(plan({ services: ["secretsmanager"], region }, { family: "aws:secrets-manager" })).success).toBe(true);
    expect(TaskDependencyPlanSchema.safeParse(plan({ services: ["sqs"], region }, { family: "aws:secrets-manager" })).success).toBe(false);
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

  it("still parses an entry that lists its available services, and one that does not", () => {
    const old = { services: { supported: ["s3"], functions: [], model_endpoint_front: [], available: ["kinesis"] }, iamEnforced: false, storage: "memory" };
    expect(EmulatorSchema.parse(old).services.available).toEqual(["kinesis"]);
    expect(EmulatorSchema.parse({ services: { supported: ["s3"], functions: [], model_endpoint_front: [] }, iamEnforced: false, storage: "memory" }).services.available).toEqual([]);
  });
});

describe("the engine pin", () => {
  const entry = (engineVersion?: string) => ({ backing: "emulated", emulator: engineVersion === undefined ? {} : { engineVersion } });

  it("passes an entry that runs the table's engine, and a backing that is not the emulator", () => {
    expect(checkEmulatorEngine(entry(AWS_EMULATOR_ENGINE_VERSION))).toEqual({ ok: true });
    expect(checkEmulatorEngine({ backing: "local" })).toEqual({ ok: true });
  });

  it("refuses an entry whose engine version differs, and one that does not say", () => {
    expect(checkEmulatorEngine(entry("1.0.321"))).toEqual({ ok: false, reason: "engine_mismatch", expected: "1.0.337", actual: "1.0.321" });
    expect(checkEmulatorEngine(entry("1.0.3370"))).toMatchObject({ ok: false, reason: "engine_mismatch" });
    expect(checkEmulatorEngine(entry())).toEqual({ ok: false, reason: "engine_not_pinned", expected: "1.0.337" });
    expect(checkEmulatorEngine({ backing: "emulated" })).toMatchObject({ ok: false, reason: "engine_not_pinned" });
  });

  it("is a field of the emulator block that takes a release number only", () => {
    const parse = (engineVersion: unknown) => EmulatorSchema.safeParse({ services: { supported: ["s3"], functions: [], model_endpoint_front: [] }, iamEnforced: false, storage: "memory", engineVersion }).success;
    expect(parse("1.0.322")).toBe(true);
    expect(parse("aws-emulator@1.0.322")).toBe(false);
    expect(parse("latest")).toBe(false);
  });
});

describe("an older-shaped catalog and the optional engine pin", () => {
  const entry = (engineVersion?: string) => ({ backing: "emulated", emulator: engineVersion === undefined ? {} : { engineVersion } });
  it("an emulator block made before the engine field still parses (strict, with no `engineVersion`), and the field stays optional", () => {
    const old = { services: { supported: ["s3", "sqs", "dynamodb"], functions: ["lambda"], model_endpoint_front: [], available: [] }, iamEnforced: false, storage: "memory" };
    expect(EmulatorSchema.safeParse(old).success).toBe(true);
    expect(EmulatorSchema.safeParse({ ...old, engineVersion: "1.0.322" }).success).toBe(true);
    expect(EmulatorSchema.safeParse({ ...old, engineVersion: "1.0.322", other: 1 }).success).toBe(false);
  });
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
  it("`cognito` is no legacy spelling of a service: user pools and identity pools are two services", () => {
    expect(normaliseAwsServiceKey("cognito")).toBeUndefined();
    expect(normaliseAwsServiceKey("cognito-idp")).toBe("cognito-identity-provider");
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

  it("has a plain JSON copy of the table with the same rows", () => {
    const copy = JSON.parse(readFileSync(new URL("../../packages/contracts/src/generated/aws-emulator-services.json", import.meta.url), "utf8")) as { engine: string; engineCommit: string; scoresSha256: string; services: unknown[]; sharedSigningNames: unknown };
    expect(copy.engine).toBe(AWS_EMULATOR_ENGINE);
    expect(copy.engineCommit).toBe(AWS_EMULATOR_ENGINE_COMMIT);
    expect(copy.scoresSha256).toBe(AWS_EMULATOR_SCORES_SHA256);
    expect(copy.services).toEqual(JSON.parse(JSON.stringify(rows)));
    expect(copy.sharedSigningNames).toEqual(JSON.parse(JSON.stringify(AWS_EMULATOR_SHARED_SIGNING_NAMES)));
  });
});
