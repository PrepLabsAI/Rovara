// Slice 2, s2-emulator-run: the emulator's ledger in the usage record (service-usage-record.ts, the ONE port). What the program chose (operation names, paths) is never shown unless it has the shape of an operation name and
// the redactor leaves it alone; counts are coarse buckets; a ledger that cannot be read is "unreadable", never "no calls"; a run with no emulator has slice 1's record byte for byte.
import { TEST_SERVICES_AWS_USAGE_LIMITS, TestServicesAwsUsageSchema, TestServicesUsageRecordSchema } from "@rovara-code/contracts";
import { describe, expect, it } from "vitest";
import { parseLedgerSummary, type EmulatorLedger, type LedgerService } from "../../packages/worker/src/emulator-ledger.js";
import { newLocalAwsCredentials } from "../../packages/worker/src/service-helpers.js";
import { createServiceRedactor, helperSecretValues } from "../../packages/worker/src/service-env.js";
import { UNREADABLE_AWS_USAGE, buildServiceUsageRecord, mergeAwsUsage, reduceAwsUsage } from "../../packages/worker/src/service-usage-record.js";

const credentials = newLocalAwsCredentials();
const redactor = createServiceRedactor(helperSecretValues([{ credentials }]));
const counts = (calls: number, unsupported = 0, errors = 0) => ({ calls, unsupported, errors });
const service = (key: string, calls: number, unsupported: number, operations: Record<string, [number, number]> = {}): LedgerService => ({
  service: key, ...counts(calls, unsupported), operations: Object.entries(operations).map(([operation, [c, u]]) => ({ operation, ...counts(c, u) })),
});

const bucketOf = (count: number): number => (count >= 21 ? 21 : count >= 6 ? 6 : count >= 2 ? 2 : count);

describe("reduceAwsUsage", () => {
  it("shows calls per service as buckets, and names an operation only when it is unsupported", () => {
    const aws = reduceAwsUsage({ services: [
      service("s3", 41, 1, { PutObject: [12, 0], GetObject: [28, 0], PutBucketReplication: [1, 1] }),
      service("sqs", 3, 0, { SendMessage: [3, 0] }),
      service("dynamodb", 1, 0, { GetItem: [1, 0] }),
    ] }, redactor);
    expect(aws).toEqual({
      ledger: "read",
      services: [{ service: "s3", calls: 21, unsupported: 1 }, { service: "sqs", calls: 2, unsupported: 0 }, { service: "dynamodb", calls: 1, unsupported: 0 }],
      unsupportedOperations: [{ service: "s3", operation: "PutBucketReplication", count: 1 }],
      otherCalls: 0, otherUnsupported: 0,
    });
    // The operations that worked are in the counts and named nowhere.
    expect(JSON.stringify(aws)).not.toMatch(/PutObject|GetObject|SendMessage|GetItem/u);
    expect(TestServicesAwsUsageSchema.parse(aws)).toEqual(aws);
  });
  it("buckets every count: 1, 2 to 5, 6 to 20, 21 or more", () => {
    const rows = [[1, 1], [2, 2], [5, 2], [6, 6], [20, 6], [21, 21], [9999, 21]] as const;
    const aws = reduceAwsUsage({ services: rows.map(([calls], index) => service(`svc${String(index)}`, calls, 0)) }, redactor);
    expect(new Map(aws.services.map((row) => [row.service, row.calls]))).toEqual(new Map(rows.map(([, bucket], index) => [`svc${String(index)}`, bucket])));
  });
  it("orders by bucket then name, so the order carries no raw count", () => {
    const aws = reduceAwsUsage({ services: [service("sqs", 7, 0), service("dynamodb", 12, 0), service("s3", 100, 0), service("sns", 2, 0)] }, redactor);
    expect(aws.services.map((row) => row.service)).toEqual(["s3", "dynamodb", "sqs", "sns"]);
  });
  it("an operation the program named in its own words is counted, not shown: a path, a lower-case word, something with a space or a symbol, one too long, a secret", () => {
    const upper = credentials.controlToken.toUpperCase();
    const keyShape = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
    const weird = {
      [`GET /${keyShape}/steal`]: [3, 3], "GET /": [1, 1], "getObject": [1, 1], "Put Object": [1, 1], "Put-Object": [1, 1], "Op": [1, 1], [`X${"a".repeat(80)}`]: [1, 1],
      [`Op${credentials.controlToken}`]: [2, 2], [`Op${upper}`]: [2, 2], [`Op${credentials.password.slice(0, 20)}${credentials.password.slice(20)}`]: [1, 1],
      PurgeEverything: [1, 1],
    } as Record<string, [number, number]>;
    const aws = reduceAwsUsage({ services: [service("s3", 50, 15, weird)] }, redactor);
    expect(aws.unsupportedOperations).toEqual([{ service: "s3", operation: "PurgeEverything", count: 1 }]);
    // 15 unsupported calls in all; one is named; the other 14 are counted in otherUnsupported (as a bucket).
    expect(aws.otherUnsupported).toBe(6);
    const text = JSON.stringify(aws).toLowerCase();
    for (const value of helperSecretValues([{ credentials }])) expect(text).not.toContain(value.toLowerCase());
    expect(text).not.toContain("akia");
  });
  it("an operation name with a whole secret in another case does not show, and a clean name beside it does (a PART of a secret is the declared residual of the record, as for names: see the top of service-usage-record.ts)", () => {
    const secret = credentials.sqsReceiptSecret;
    const aws = reduceAwsUsage({ services: [service("sqs", 4, 4, { [`Send${secret.toUpperCase()}`]: [1, 1], [`Send${secret.toLowerCase()}`]: [1, 1], PutThing: [2, 2] }) ] }, redactor);
    expect(aws.unsupportedOperations).toEqual([{ service: "sqs", operation: "PutThing", count: 2 }]);
  });
  it("a service key that is not a plain key, or that holds a secret, is not shown: its calls go to otherCalls", () => {
    const aws = reduceAwsUsage({ services: [
      service("s3", 2, 0), service("Not A Key", 7, 7, { Boom: [7, 7] }), service(credentials.controlToken.toLowerCase(), 30, 0), service("x", 3, 0),
    ] }, redactor);
    expect(aws.services.map((row) => row.service)).toEqual(["s3"]);
    // 7 + 30 (+ the one-character 'x' key, which is not a service key either) = 40 calls hidden: bucket 21.
    expect(aws.otherCalls).toBe(21);
    expect(aws.otherUnsupported).toBe(6);
    expect(aws.unsupportedOperations).toEqual([]);
    expect(JSON.stringify(aws).toLowerCase()).not.toContain(credentials.controlToken.toLowerCase());
  });
  it("is capped: 24 services in the narrow record an older broker reads, 64 in the wide one, and 30 unsupported operations are named; the rest are counted", () => {
    const limit = TEST_SERVICES_AWS_USAGE_LIMITS.services;
    const many: LedgerService[] = Array.from({ length: limit + 6 }, (_value, index) => service(`svc${String(index).padStart(2, "0")}`, 3, 0));
    const aws = reduceAwsUsage({ services: many }, redactor, { wide: true });
    expect(aws.services).toHaveLength(limit);
    expect(aws.otherCalls).toBe(6);
    const narrow = reduceAwsUsage({ services: many }, redactor);
    expect(narrow.services).toHaveLength(TEST_SERVICES_AWS_USAGE_LIMITS.narrowServices);
    expect(narrow.otherCalls).toBe(bucketOf(3 * (limit + 6 - TEST_SERVICES_AWS_USAGE_LIMITS.narrowServices)));
    const ops: Record<string, [number, number]> = {};
    for (let index = 0; index < 40; index += 1) ops[`Op${String(index).padStart(2, "0")}`] = [1, 1];
    const capped = reduceAwsUsage({ services: [service("s3", 40, 40, ops)] }, redactor);
    expect(capped.unsupportedOperations).toHaveLength(30);
    expect(capped.otherUnsupported).toBe(6);
    expect(TestServicesAwsUsageSchema.parse(capped)).toEqual(capped);
  });
  it("the same service twice is added; a service with no calls is left out; an empty ledger is a read ledger with nothing in it", () => {
    const aws = reduceAwsUsage({ services: [service("s3", 1, 0), service("s3", 1, 0), service("sqs", 0, 0)] }, redactor);
    expect(aws.services).toEqual([{ service: "s3", calls: 2, unsupported: 0 }]);
    expect(reduceAwsUsage({ services: [] }, redactor)).toEqual({ ledger: "read", services: [], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 });
  });
  it("keeps an out-of-plan count in a wide record only, never above the calls, and a ledger that does not say leaves it out", () => {
    const ledger: EmulatorLedger = { services: [{ ...service("sns", 7, 0), outOfPlan: 7 }, { ...service("s3", 30, 0), outOfPlan: 0 }, service("sqs", 3, 0)] };
    const wide = reduceAwsUsage(ledger, redactor, { wide: true });
    expect(wide.services).toEqual([{ service: "s3", calls: 21, unsupported: 0 }, { service: "sns", calls: 6, unsupported: 0, outOfPlan: 6 }, { service: "sqs", calls: 2, unsupported: 0 }]);
    expect(TestServicesAwsUsageSchema.parse(wide)).toEqual(wide);
    // A broker from before the all-services feature rejects the field: the narrow record never has it.
    expect(JSON.stringify(reduceAwsUsage(ledger, redactor))).not.toContain("outOfPlan");
  });
  it("one service under every name the emulator may call it: a legacy id, a key, a signing name", () => {
    const aws = reduceAwsUsage({ services: [service("secretsmanager", 2, 0), service("secrets-manager", 3, 0), service("monitoring", 1, 0), service("events", 1, 1, { Frobnicate: [1, 1] }), service("apigateway", 1, 0)] }, redactor);
    expect(aws.services.map((row) => [row.service, row.calls]).sort()).toEqual([["api-gateway", 1], ["cloudwatch", 1], ["eventbridge", 1], ["secrets-manager", 2]]);
    expect(aws.unsupportedOperations).toEqual([{ service: "eventbridge", operation: "Frobnicate", count: 1 }]);
  });
  it("reads an out-of-plan count from the ledger's summary, and refuses one that is not a count", () => {
    const summary = (outOfPlan: unknown) => JSON.stringify({ sns: { calls: 3, unsupported: 0, errors: 0, ...(outOfPlan === undefined ? {} : { outOfPlan }), operations: { Publish: { calls: 3, unsupported: 0, errors: 0 } } } });
    expect(parseLedgerSummary(summary(3)).services[0]).toMatchObject({ service: "sns", calls: 3, outOfPlan: 3 });
    expect(parseLedgerSummary(summary(undefined)).services[0]).not.toHaveProperty("outOfPlan");
    for (const bad of [-1, 1.5, "3", null]) expect(() => parseLedgerSummary(summary(bad))).toThrow();
  });
  it("a prototype-pollution-shaped name is just text", () => {
    const aws = reduceAwsUsage({ services: [service("s3", 2, 2, JSON.parse('{"__proto__":[1,1],"constructor":[1,1]}') as Record<string, [number, number]>)] }, redactor);
    expect(aws.unsupportedOperations).toEqual([]);
    expect(Object.keys(aws)).toEqual(["ledger", "services", "unsupportedOperations", "otherCalls", "otherUnsupported"]);
  });
});

describe("buildServiceUsageRecord with the emulator port", () => {
  const base = { planned: [], redactor } as const;
  it("a run with no emulator has no aws field at all: slice 1's record, byte for byte", async () => {
    const without = await buildServiceUsageRecord({ ...base });
    expect(Object.keys(without)).toEqual(["schemaVersion", "dependencies", "unknownCalls"]);
    expect(JSON.stringify(without)).toBe('{"schemaVersion":1,"dependencies":[],"unknownCalls":{"domains":[],"otherCount":0}}');
  });
  it("with the port, the record carries the reduced ledger and still parses with the broker's contract", async () => {
    const ledger: EmulatorLedger = { services: [service("s3", 12, 1, { PutObject: [11, 0], SelectObjectContent: [1, 1] })] };
    const record = await buildServiceUsageRecord({ ...base, emulator: () => Promise.resolve(ledger) });
    expect(record.aws).toEqual({ ledger: "read", services: [{ service: "s3", calls: 6, unsupported: 1 }], unsupportedOperations: [{ service: "s3", operation: "SelectObjectContent", count: 1 }], otherCalls: 0, otherUnsupported: 0 });
    expect(TestServicesUsageRecordSchema.parse(record)).toEqual(record);
  });
  it("fails closed: a port that throws, never answers, or gives a ledger that does not reduce to a valid record is 'unreadable' with nothing else", async () => {
    const throwing = await buildServiceUsageRecord({ ...base, emulator: () => Promise.reject(new Error(`boom ${credentials.controlToken}`)) });
    expect(throwing.aws).toEqual(UNREADABLE_AWS_USAGE);
    expect(JSON.stringify(throwing)).not.toContain(credentials.controlToken);
    const silent = await buildServiceUsageRecord({ ...base, ledgerLimitMs: 20, emulator: () => new Promise<EmulatorLedger>(() => undefined) });
    expect(silent.aws).toEqual(UNREADABLE_AWS_USAGE);
    const absurd = await buildServiceUsageRecord({ ...base, emulator: () => Promise.resolve({ services: [service("s3", Number.MAX_SAFE_INTEGER, 0)] }) });
    // clamped to the contract's limit, so it still reads (as the 21+ bucket) and is valid
    expect(absurd.aws?.ledger).toBe("read");
    expect(TestServicesUsageRecordSchema.parse(absurd)).toEqual(absurd);
    const broken = await buildServiceUsageRecord({ ...base, emulator: () => Promise.resolve(null as unknown as EmulatorLedger) });
    expect(broken.aws).toEqual(UNREADABLE_AWS_USAGE);
  });
  it("an unreadable ledger cannot also claim calls (the contract refuses it)", () => {
    expect(TestServicesAwsUsageSchema.safeParse({ ...UNREADABLE_AWS_USAGE, otherCalls: 1 }).success).toBe(false);
    expect(TestServicesAwsUsageSchema.safeParse({ ...UNREADABLE_AWS_USAGE, services: [{ service: "s3", calls: 1, unsupported: 0 }] }).success).toBe(false);
    expect(TestServicesAwsUsageSchema.safeParse(UNREADABLE_AWS_USAGE).success).toBe(true);
  });
  it("the record never holds a secret of the run, whatever the ledger said", async () => {
    const ledger: EmulatorLedger = { services: [service("s3", 9, 9, Object.fromEntries(helperSecretValues([{ credentials }]).flatMap((value) => [[`Put${value}`, [3, 3]], [`Put${value.toUpperCase()}`, [3, 3]]]))) , service(credentials.password, 4, 0)] };
    const record = await buildServiceUsageRecord({ ...base, emulator: () => Promise.resolve(ledger) });
    const text = JSON.stringify(record).toLowerCase();
    for (const value of helperSecretValues([{ credentials }])) expect(text).not.toContain(value.toLowerCase());
  });
});

describe("mergeAwsUsage (the rounds of one run)", () => {
  const read = (services: Array<[string, number, number]>, ops: Array<[string, string, number]> = [], other: [number, number] = [0, 0]) => ({
    ledger: "read" as const, services: services.map(([service, calls, unsupported]) => ({ service, calls, unsupported })),
    unsupportedOperations: ops.map(([service, operation, count]) => ({ service, operation, count })), otherCalls: other[0], otherUnsupported: other[1],
  });
  it("adds the services and the operations of both", () => {
    const merged = mergeAwsUsage(read([["s3", 2, 1], ["sqs", 1, 0]], [["s3", "PutThing", 1]]), read([["s3", 6, 1]], [["s3", "PutThing", 1], ["sqs", "OtherThing", 2]], [3, 1]));
    expect(merged).toEqual(read([["s3", 8, 2], ["sqs", 1, 0]], [["s3", "PutThing", 2], ["sqs", "OtherThing", 2]], [3, 1]));
    expect(TestServicesAwsUsageSchema.parse(merged)).toEqual(merged);
  });
  it("one side absent is the other; an unreadable ledger in either round makes the whole unreadable", () => {
    const one = read([["s3", 2, 0]]);
    expect(mergeAwsUsage(undefined, one)).toEqual(one);
    expect(mergeAwsUsage(one, undefined)).toEqual(one);
    expect(mergeAwsUsage(undefined, undefined)).toBeUndefined();
    expect(mergeAwsUsage(one, UNREADABLE_AWS_USAGE)).toEqual(UNREADABLE_AWS_USAGE);
    expect(mergeAwsUsage(UNREADABLE_AWS_USAGE, one)).toEqual(UNREADABLE_AWS_USAGE);
  });
  it("cuts the lists again and counts the overflow", () => {
    const a = read(Array.from({ length: TEST_SERVICES_AWS_USAGE_LIMITS.services }, (_v, index) => [`svc${String(index).padStart(2, "0")}`, 6, 0] as [string, number, number]));
    const b = read([["zzz", 2, 0]]);
    const merged = mergeAwsUsage(a, b, true)!;
    expect(merged.services).toHaveLength(TEST_SERVICES_AWS_USAGE_LIMITS.services);
    expect(merged.otherCalls).toBe(2);
    expect(mergeAwsUsage(a, b)!.services).toHaveLength(TEST_SERVICES_AWS_USAGE_LIMITS.narrowServices);
  });
  it("adds out-of-plan counts of a wide record, and drops them from a narrow one", () => {
    const row = (calls: number, outOfPlan: number) => ({ ledger: "read" as const, services: [{ service: "sns", calls, unsupported: 0, outOfPlan }], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 });
    const wide = mergeAwsUsage(row(6, 6), row(2, 2), true)!;
    expect(wide.services).toEqual([{ service: "sns", calls: 8, unsupported: 0, outOfPlan: 8 }]);
    expect(TestServicesAwsUsageSchema.parse(wide)).toEqual(wide);
    expect(mergeAwsUsage(row(6, 6), row(2, 2))!.services).toEqual([{ service: "sns", calls: 8, unsupported: 0 }]);
  });
});
