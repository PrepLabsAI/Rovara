// Test services TS26 (DC-TS-2): `testAccountWidened(previous, next)` says whether a change to a test account needs fresh approvals. A pure narrowing (fewer hosts, actions, resources, variables or
// projects, or lower limits) applies at once and re-stamps the approvals; anything else (and anything this function cannot prove is smaller) is a widening.
import { describe, expect, it } from "vitest";
import * as acc from "../../packages/contracts/src/test-account.js";

const ORG = `org_${"a1b2c3d4e5".repeat(2)}`;
const base = (over: Record<string, unknown> = {}) => ({
  id: "payments-test", orgId: ORG, projectIds: ["orders", "billing"] as "all" | string[], kind: "api_key", family: "http:api.example-pay.com", hosts: ["api.example-pay.com", "files.example-pay.com"],
  envNames: ["PAYMENTS_API_KEY", "PAYMENTS_KEY_COPY"], limits: { maxConnectionsPerRun: 2_000, maxConnectionsPerDay: 20_000, maxConcurrentRounds: 2 },
  secretRef: acc.testAccountSecretRef("staging", ORG, "payments-test", "apiKey"), ...over,
});
const awsBase = (over: Record<string, unknown> = {}, aws: Record<string, unknown> = {}) => base({
  id: "orders-dev", kind: "aws_role", family: "aws:dynamodb", secretRef: undefined, envNames: [], hosts: ["dynamodb.us-west-2.amazonaws.com"],
  aws: { roleArn: "arn:aws:iam::222222222222:role/rovara-test", externalId: "ext-0123456789", region: "us-west-2", actions: ["dynamodb:GetItem", "dynamodb:PutItem"], resources: ["arn:aws:dynamodb:us-west-2:222222222222:table/orders-test", "arn:aws:dynamodb:us-west-2:222222222222:table/orders-test/index/*"], ...aws },
  ...over,
});
const widened = (previous: unknown, next: unknown) => acc.testAccountWidened(previous as never, next as never);

describe("testAccountWidened", () => {
  it("is true for each widening", () => {
    expect(widened(base(), base({ hosts: [...base().hosts, "other.example-pay.com"] }))).toBe(true);
    expect(widened(base(), base({ hosts: ["other.example-pay.com"] }))).toBe(true);
    expect(widened(base(), base({ envNames: [...base().envNames, "EXTRA_VAR"] }))).toBe(true);
    expect(widened(base(), base({ projectIds: ["orders", "billing", "web"] }))).toBe(true);
    expect(widened(base(), base({ projectIds: "all" }))).toBe(true);
    expect(widened(base(), base({ projectIds: ["web"] }))).toBe(true);
    for (const key of ["maxConnectionsPerRun", "maxConnectionsPerDay", "maxConcurrentRounds"]) {
      expect(widened(base(), base({ limits: { ...base().limits, [key]: base().limits[key as "maxConnectionsPerRun"] + 1 } })), key).toBe(true);
    }
  });
  it("is true for a changed identity: id, org, kind, family or secret reference (another credential is not a narrowing)", () => {
    expect(widened(base(), base({ id: "other" }))).toBe(true);
    expect(widened(base(), base({ orgId: `org_${"z".repeat(20)}` }))).toBe(true);
    expect(widened(base(), base({ kind: "basic" }))).toBe(true);
    expect(widened(base(), base({ family: "http:files.example-pay.com" }))).toBe(true);
    expect(widened(base(), base({ secretRef: acc.testAccountSecretRef("staging", ORG, "payments-test", "otherKey") }))).toBe(true);
    expect(widened(base(), base({ secretRef: undefined }))).toBe(true);
    expect(widened(base({ secretRef: undefined }), base())).toBe(true);
  });
  it("treats an AWS block the same way: fewer actions or resources narrow, anything else widens", () => {
    expect(widened(awsBase(), awsBase())).toBe(false);
    expect(widened(awsBase(), awsBase({}, { actions: ["dynamodb:GetItem"] }))).toBe(false);
    expect(widened(awsBase(), awsBase({}, { resources: ["arn:aws:dynamodb:us-west-2:222222222222:table/orders-test"] }))).toBe(false);
    expect(widened(awsBase(), awsBase({}, { actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Scan"] }))).toBe(true);
    expect(widened(awsBase(), awsBase({}, { resources: [...((awsBase() as unknown as { aws: { resources: string[] } }).aws.resources), "arn:aws:dynamodb:us-west-2:222222222222:table/other"] }))).toBe(true);
    expect(widened(awsBase(), awsBase({}, { roleArn: "arn:aws:iam::222222222222:role/another" }))).toBe(true);
    expect(widened(awsBase(), awsBase({}, { externalId: "ext-9999999999" }))).toBe(true);
    expect(widened(awsBase(), awsBase({}, { region: "us-east-1" }))).toBe(true);
    expect(widened(awsBase(), awsBase({ aws: undefined }))).toBe(true);
    expect(widened(awsBase({ aws: undefined }), awsBase())).toBe(true);
  });
  it("covers a resource only by an exact match or by a named prefix ending /*, never by a bare type", () => {
    const s3 = (resources: string[]) => awsBase({ family: "aws:s3", hosts: ["s3.us-west-2.amazonaws.com"] }, { actions: ["s3:GetObject"], resources });
    expect(widened(s3(["arn:aws:s3:::bucket-a/*"]), s3(["arn:aws:s3:::bucket-a/reports/*"]))).toBe(false);
    expect(widened(s3(["arn:aws:s3:::bucket-a/*"]), s3(["arn:aws:s3:::bucket-a/reports/2026.csv"]))).toBe(false);
    // The bucket itself is not covered by `bucket/*`, and neither is another bucket whose name starts the same way.
    expect(widened(s3(["arn:aws:s3:::bucket-a/*"]), s3(["arn:aws:s3:::bucket-a"]))).toBe(true);
    expect(widened(s3(["arn:aws:s3:::bucket-a/*"]), s3(["arn:aws:s3:::bucket-a-evil/x"]))).toBe(true);
    expect(widened(s3(["arn:aws:s3:::bucket-a/reports/*"]), s3(["arn:aws:s3:::bucket-a/*"]))).toBe(true);
    // A wildcard anywhere else, or an empty rest, is never provably smaller.
    expect(widened(s3(["arn:aws:s3:::bucket-a/*"]), s3(["arn:aws:s3:::bucket-a/re*"]))).toBe(true);
    expect(widened(s3(["arn:aws:s3:::bucket-a/*"]), s3(["arn:aws:s3:::bucket-a/*/x"]))).toBe(true);
    expect(widened(s3(["arn:aws:s3:::bucket-a/*"]), s3(["arn:aws:s3:::bucket-a//x"]))).toBe(true);
    expect(widened(s3(["arn:aws:s3:::bucket-a/*"]), s3(["arn:aws:s3:::bucket-a/?"]))).toBe(true);
    expect(widened(s3(["arn:aws:s3:::bucket-a/*"]), s3(["arn:aws:s3:::bucket-a/"]))).toBe(true);
  });
});

describe("restampApprovals", () => {
  const person = (letter: string) => letter.repeat(64);
  const stamped = (record: ReturnType<typeof base>, by: string[]) => ({ ...record, approvals: by.map((letter) => ({ by: person(letter), at: "2026-11-02T10:00:00.000Z", freshSignIn: true as const, kind: "approver" as const, approvedDigest: acc.testAccountApprovalDigest(record as never) })) });
  it("moves the approvals of the previous record onto the narrower one and drops approvals of anything else", () => {
    const previous = { ...stamped(base(), ["a", "b"]) };
    previous.approvals.push({ ...previous.approvals[0]!, by: person("c"), approvedDigest: "f".repeat(64) });
    const next = base({ hosts: ["api.example-pay.com"] });
    const result = acc.restampApprovals(previous, next);
    expect(result.map((each) => each.by)).toEqual([person("a"), person("b")]);
    expect(result.every((each) => each.approvedDigest === acc.testAccountApprovalDigest(next as never))).toBe(true);
    expect(acc.testAccountQualifyingApprovals({ ...next, approvals: result })).toHaveLength(2);
  });
  it("refuses a widening", () => {
    expect(() => acc.restampApprovals(stamped(base(), ["a", "b"]) as never, base({ projectIds: "all" }) as never)).toThrow(RangeError);
  });
});

describe("the run-time secret grant", () => {
  // Credential-shaped strings are built at run time.
  const token = (letter: string) => ["T", letter.repeat(30)].join("");
  const grant = (over: Record<string, unknown> = {}) => ({
    orgId: ORG, accountId: "payments-test", family: "http:api.example-pay.com", secretName: acc.testAccountSecretName("staging", ORG, "payments-test"), key: "apiKey", region: "us-west-2",
    envNames: ["PAYMENTS_API_KEY"], credentials: { accessKeyId: token("a"), secretAccessKey: token("b"), sessionToken: token("c") }, expiresAt: "2026-11-02T10:15:00.000Z", ...over,
  });
  it("parses a grant for the account's own secret", () => {
    expect(acc.parseTestAccountSecretGrant(grant())).toEqual(grant());
  });
  it("refuses another org's or another account's secret, a connector path, an extra member and a reserved variable", () => {
    for (const bad of [
      grant({ secretName: acc.testAccountSecretName("staging", ORG, "other-account") }),
      grant({ secretName: acc.testAccountSecretName("staging", `org_${"z".repeat(20)}`, "payments-test") }),
      grant({ secretName: `agentx/staging/org-connectors/${ORG}/payments-test` }),
      { ...grant(), value: "x" }, grant({ envNames: [] }), grant({ envNames: ["PATH"] }), grant({ envNames: ["A_ONE", "A_ONE"] }), grant({ key: "a/b" }),
      grant({ credentials: { accessKeyId: "has space", secretAccessKey: "x", sessionToken: "y" } }), grant({ expiresAt: "soon" }),
    ]) expect(acc.parseTestAccountSecretGrant(bad)).toBeUndefined();
  });
});
