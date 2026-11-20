// Test services TS4 (contract): the test-account record (a reference, never a value), the org-tagged secret name, the key-shape table that refuses live-shaped keys, and the production deny-list checks.
// Every key-shaped string below is built at runtime from parts: the public repository's push protection refuses a key-shaped literal.
import { describe, expect, it } from "vitest";
import * as acc from "../../packages/contracts/src/test-account.js";
import * as shared from "../../packages/contracts/src/test-services-shared.js";

const ORG = `org_${"a1b2c3d4e5".repeat(2)}`;
const OTHER_ORG = `org_${"z9y8x7w6v5".repeat(2)}`;
const person = (letter: string) => letter.repeat(64);
const sha = (letter: string) => letter.repeat(64);
// An approval is stamped with the digest of the record it ends up in (see `account`), unless the test gives its own `approvedDigest`.
const approval = (by: string, over: Record<string, unknown> = {}) => ({ by: person(by), at: "2026-11-02T10:00:00.000Z", freshSignIn: true, kind: "approver", ...over });
const ref = (over: { env?: string; org?: string; id?: string; key?: string } = {}) => acc.testAccountSecretRef(over.env ?? "staging", over.org ?? ORG, over.id ?? "payments-test", over.key ?? "apiKey");
const withoutDigest = (approvals: unknown): Array<Record<string, unknown>> => (approvals as Array<Record<string, unknown>>).map((each) => Object.fromEntries(Object.entries(each).filter(([key]) => key !== "approvedDigest")));
const stamp = (record: Record<string, unknown>): Record<string, unknown> => {
  const digest = acc.testAccountApprovalDigest(record as never);
  return { ...record, approvals: (record.approvals as Array<Record<string, unknown>>).map((each) => (each.approvedDigest === undefined ? { ...each, approvedDigest: digest } : each)) };
};
/** An AWS block without an external id gets the one Rovara derives for the record's own org and id, as the broker does. */
const withDerivedExternalId = (record: Record<string, unknown>): Record<string, unknown> => {
  const aws = record.aws as Record<string, unknown> | undefined;
  return aws === undefined || aws.externalId !== undefined ? record : { ...record, aws: { ...aws, externalId: acc.testAccountExternalId(String(record.orgId), String(record.id)) } };
};
const account = (over: Record<string, unknown> = {}) => stamp(withDerivedExternalId({
  id: "payments-test", orgId: ORG, projectIds: ["orders", "billing"], family: "http:api.example-pay.com", label: "Payments test mode", kind: "api_key", secretRef: ref(),
  hosts: ["api.example-pay.com"], envNames: ["PAYMENTS_API_KEY"], limits: { maxConnectionsPerRun: 2_000, maxConnectionsPerDay: 20_000, maxConcurrentRounds: 2 },
  approvals: [approval("a"), approval("b")], status: "active", expiresAt: "2027-01-30T10:00:00.000Z", ...over,
}));
const awsBlock = (over: Record<string, unknown> = {}) => ({
  roleArn: "arn:aws:iam::222222222222:role/rovara-test", region: "us-west-2", actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
  resources: ["arn:aws:dynamodb:us-west-2:222222222222:table/orders-test"], ...over,
});
const awsAccount = (over: Record<string, unknown> = {}) => account({ id: "orders-dev", family: "aws:dynamodb", label: "Dev AWS (orders)", kind: "aws_role", secretRef: undefined, aws: awsBlock(), hosts: ["dynamodb.us-west-2.amazonaws.com"], envNames: [], ...over });
const s3Account = (over: Record<string, unknown> = {}) => awsAccount({ id: "orders-files", family: "aws:s3", label: "Dev S3 (orders)", aws: awsBlock({ actions: ["s3:GetObject"], resources: ["arn:aws:s3:::orders-test-bucket/*"] }), hosts: ["s3.us-west-2.amazonaws.com"], ...over });
/** An account for each service of the allow-list, built with one chosen action: the same service, the right resource and the right endpoint. */
const awsFixtures: Record<string, (action: string) => Record<string, unknown>> = {
  s3: (action) => s3Account({ aws: awsBlock({ actions: [action], resources: ["arn:aws:s3:::orders-test-bucket", "arn:aws:s3:::orders-test-bucket/*"] }) }),
  dynamodb: (action) => awsAccount({ aws: awsBlock({ actions: [action] }) }),
  sqs: (action) => awsAccount({ family: "aws:sqs", hosts: ["sqs.us-west-2.amazonaws.com"], aws: awsBlock({ actions: [action], resources: ["arn:aws:sqs:us-west-2:222222222222:orders-queue"] }) }),
  sns: (action) => awsAccount({ family: "aws:sns", hosts: ["sns.us-west-2.amazonaws.com"], aws: awsBlock({ actions: [action], resources: ["arn:aws:sns:us-west-2:222222222222:orders-topic"] }) }),
  kinesis: (action) => awsAccount({ family: "aws:kinesis", hosts: ["kinesis.us-west-2.amazonaws.com"], aws: awsBlock({ actions: [action], resources: ["arn:aws:kinesis:us-west-2:222222222222:stream/orders-stream"] }) }),
  events: (action) => awsAccount({ family: "aws:events", hosts: ["events.us-west-2.amazonaws.com"], aws: awsBlock({ actions: [action], resources: ["arn:aws:events:us-west-2:222222222222:event-bus/orders-bus"] }) }),
  sagemaker: (action) => awsAccount({ family: "aws:sagemaker-runtime", hosts: ["runtime.sagemaker.us-west-2.amazonaws.com"], aws: awsBlock({ actions: [action], resources: ["arn:aws:sagemaker:us-west-2:222222222222:endpoint/scorer"] }) }),
};
const ok = (value: unknown) => acc.TestAccountSchema.safeParse(value).success;
const parsed = (value: Record<string, unknown>) => acc.TestAccountSchema.parse(value);
const deny = (over: Partial<{ accountIds: string[]; hosts: string[]; arnPrefixes: string[] }> = {}) => ({ accountIds: [], hosts: [], arnPrefixes: [], ...over });
// Key-shaped values, built here so no literal in this file is one.
const build = (...parts: string[]) => parts.join("");
const rand = (length: number) => "Qk7mP2xR9vLw4NtY8bZc3HdF6gJs1VaUeXoI5".repeat(3).slice(0, length);
const stripeLive = () => build("sk", "_", "live", "_", rand(24));
const stripeTest = () => build("sk", "_", "test", "_", rand(24));
const awsKeyId = (prefix = "AKIA") => build(prefix, "ABCDEFGHIJKLMNOP");

describe("TestAccount record", () => {
  it("is strict: no member can hold a value", () => {
    for (const key of ["value", "secret", "token", "apiKey", "password", "secretValue", "credentials", "key"]) expect(ok({ ...account(), [key]: "x" }), key).toBe(false);
    expect(ok({ ...account(), aws: awsBlock() })).toBe(false);
    expect(ok(awsAccount({ aws: { ...awsBlock(), secretAccessKey: "x" } }))).toBe(false);
    expect(ok(account({ limits: { maxConnectionsPerRun: 1, maxConnectionsPerDay: 1, maxConcurrentRounds: 1, extra: 1 } }))).toBe(false);
    expect(ok(account({ approvals: [{ ...approval("a"), extra: 1 }, approval("b")] }))).toBe(false);
  });
  it("needs the secret reference for an API key, an OAuth client and a basic account, but not for a pre-prod endpoint", () => {
    for (const kind of ["api_key", "oauth_client", "basic"]) {
      expect(ok(account({ kind })), kind).toBe(true);
      expect(ok(account({ kind, secretRef: undefined })), kind).toBe(false);
    }
    expect(ok(account({ kind: "preprod_endpoint", secretRef: undefined, envNames: [] }))).toBe(true);
  });

  describe("secret reference", () => {
    it("must point at this org's own path", () => {
      expect(ok(account({ secretRef: ref({ org: OTHER_ORG }) }))).toBe(false);
    });
    it("is refused on an AWS role account, which stores no secret", () => {
      expect(ok(awsAccount({ secretRef: ref({ id: "orders-dev" }) }))).toBe(false);
    });
  });

  describe("kinds, families and the AWS block", () => {
    it("accepts an AWS role account and needs the block exactly for that kind", () => {
      expect(ok(awsAccount())).toBe(true);
      expect(ok(awsAccount({ aws: undefined }))).toBe(false);
      expect(ok(account({ aws: awsBlock() }))).toBe(false);
    });
    it("keeps AWS families to AWS accounts and http families to the others", () => {
      expect(ok(account({ family: "aws:dynamodb" }))).toBe(false);
      expect(ok(awsAccount({ family: "http:api.example-pay.com" }))).toBe(false);
      expect(ok(account({ family: "postgres" }))).toBe(false);
      // The account's own host listed and its action approved is not enough: an AWS role account is for an AWS family.
      expect(ok(awsAccount({ family: "http:dynamodb.us-west-2.amazonaws.com" }))).toBe(false);
    });
    it("has explicit actions only: no wildcard, no malformed action", () => {
      for (const action of ["*", "dynamodb:*", "dynamodb:Get*", "dynamodb", "dynamodb:Get Item", "DynamoDB:GetItem:x", "dynamodb:?etItem", ""]) expect(ok(awsAccount({ aws: awsBlock({ actions: [action, "dynamodb:GetItem"] }) })), action).toBe(false);
    });
    it("allows only the data-plane actions of the allow-list, each in its own service", () => {
      const wanted: Record<string, string[]> = {
        s3: ["GetObject", "PutObject", "DeleteObject", "ListBucket"],
        dynamodb: ["GetItem", "PutItem", "UpdateItem", "DeleteItem", "Query", "Scan", "BatchGetItem", "BatchWriteItem"],
        sqs: ["SendMessage", "ReceiveMessage", "DeleteMessage", "GetQueueAttributes", "GetQueueUrl"],
        sns: ["Publish"],
        kinesis: ["PutRecord", "PutRecords", "GetRecords", "GetShardIterator"],
        events: ["PutEvents"],
        sagemaker: ["InvokeEndpoint"],
      };
      expect(acc.TEST_ACCOUNT_AWS_ACTIONS).toEqual(wanted);
      for (const [service, names] of Object.entries(wanted)) {
        const fixture = awsFixtures[service]!;
        for (const name of names) expect(ok(fixture(`${service}:${name}`)), `${service}:${name}`).toBe(true);
      }
    });
    it("names its resources: never a wildcard bucket, a whole service, a cross-account, cross-region or cross-partition one", () => {
      const s3 = (resources: string[], over: Record<string, unknown> = {}) => s3Account({ aws: awsBlock({ actions: ["s3:GetObject", "s3:ListBucket"], resources, ...over }) });
      const ddb = (resources: string[]) => awsAccount({ aws: awsBlock({ resources }) });
      // allowed
      expect(ok(s3(["arn:aws:s3:::orders-test-bucket", "arn:aws:s3:::orders-test-bucket/*", "arn:aws:s3:::orders-test-bucket/exports/2026/*"]))).toBe(true);
      expect(ok(ddb(["arn:aws:dynamodb:us-west-2:222222222222:table/orders-test", "arn:aws:dynamodb:us-west-2:222222222222:table/orders-test/index/*", "arn:aws:dynamodb:us-west-2:222222222222:table/orders-test/index/by-owner"]))).toBe(true);
      // the probes of the review
      for (const resource of ["arn:aws:s3:::*/*", "arn:aws:s3:::**", "arn:aws:s3:::*", "arn:aws:s3:::orders-test-bucket/**", "arn:aws:s3:::orders-test-bucket/*?", "arn:aws:s3:::orders-*/*", "arn:aws:s3:::?rders-test-bucket/*", "arn:aws:s3:::/*", "arn:aws:s3:::orders-test-bucket/*/*", "arn:aws:s3:::orders-test-bucket/a*b", "arn:aws:s3:::orders-test-bucket/*x"]) expect(ok(s3([resource])), resource).toBe(false);
      for (const resource of ["arn:aws:s3::999988887777:orders-test-bucket", "arn:aws:s3:us-west-2:222222222222:orders-test-bucket/*", "arn:aws:s3:us-west-2::orders-test-bucket", "arn:aws:s3::222222222222:orders-test-bucket"]) expect(ok(s3([resource])), resource).toBe(false);
      for (const resource of ["arn:aws:s3:::192.168.1.1/*", "arn:aws:s3:::1.2.3.4", "arn:aws:s3:::orders..bucket", "arn:aws:s3:::orders.-bucket", "arn:aws:s3:::xn--orders", "arn:aws:s3:::A", "arn:aws:s3:::Orders-Test", "arn:aws:s3:::ab", "arn:aws:s3:::-orders", "arn:aws:s3:::orders_bucket", "arn:aws:s3:::orders test"]) expect(ok(s3([resource])), resource).toBe(false);
      for (const resource of ["*", "arn:aws:dynamodb:us-west-2:222222222222:*", "arn:aws:dynamodb:*:*:*", "arn:aws:dynamodb:us-west-2:222222222222:table/*", "arn:aws:dynamodb:us-west-2:222222222222:table/orders-*", "arn:aws:dynamodb:us-west-2:222222222222:table/orders-test*", "arn:aws:dynamodb:us-west-2:222222222222:table/t*?", "arn:aws:dynamodb:us-west-2:222222222222:table/orders-test?", "arn:aws:dynamodb:us-west-2:222222222222:table/*/index/x", "arn:aws:dynamodb:us-west-2:222222222222:*/orders-test", "arn:aws:dynamodb:us-west-2:222222222222:table/orders-test/*/*", "arn:aws:dynamodb:us-west-2:222222222222:/*", "arn:aws:dynamodb:us-west-2:222222222222:", "arn:aws:dynamodb:us-west-2:222222222222:table//x"]) expect(ok(ddb([resource])), resource).toBe(false);
      for (const resource of ["arn:aws:dynamodb:us-west-2:999988887777:table/orders-test", "arn:aws:dynamodb:us-east-1:222222222222:table/orders-test", "arn:aws:dynamodb::222222222222:table/orders-test", "arn:aws:dynamodb:us-west-2::table/orders-test", "arn:aws-cn:dynamodb:us-west-2:222222222222:table/orders-test", "arn:aws-us-gov:dynamodb:us-west-2:222222222222:table/orders-test", "arn:aws:dynamodb:*:222222222222:table/orders-test", "arn:aws:dynamodb:us-west-2:*:table/orders-test", "arn:*:dynamodb:us-west-2:222222222222:table/orders-test"]) expect(ok(ddb([resource])), resource).toBe(false);
      // a name that begins with a slash is no name
      for (const resource of ["arn:aws:dynamodb:us-west-2:222222222222:/orders-test", "arn:aws:dynamodb:us-west-2:222222222222:/table/orders-test"]) expect(ok(ddb([resource])), resource).toBe(false);
      // the role's partition is the resources' partition
      const china = (resources: string[]) => awsAccount({ aws: awsBlock({ roleArn: "arn:aws-cn:iam::222222222222:role/rovara-test", resources }) });
      expect(ok(china(["arn:aws-cn:dynamodb:us-west-2:222222222222:table/orders-test"]))).toBe(true);
      expect(ok(china(["arn:aws:dynamodb:us-west-2:222222222222:table/orders-test"]))).toBe(false);
      // a resource of a service whose action is not approved
      expect(ok(ddb(["arn:aws:sqs:us-west-2:222222222222:orders-queue"]))).toBe(false);
      expect(ok(ddb(["arn:aws:s3:::orders-test-bucket"]))).toBe(false);
      // one bad resource among good ones refuses the lot
      expect(ok(ddb(["arn:aws:dynamodb:us-west-2:222222222222:table/orders-test", "arn:aws:dynamodb:us-west-2:222222222222:table/*"]))).toBe(false);
    });
    it("checks a resource against the role's own partition, region and account in one place", () => {
      const role = { partition: "aws", account: "222222222222", region: "us-west-2" };
      const services = new Set(["dynamodb", "s3"]);
      expect(acc.awsResourceProblem("arn:aws:dynamodb:us-west-2:222222222222:table/t1", role, services)).toBeUndefined();
      expect(acc.awsResourceProblem("arn:aws-cn:dynamodb:us-west-2:222222222222:table/t1", role, services)).toBe("partition");
      expect(acc.awsResourceProblem("arn:aws:sqs:us-west-2:222222222222:q", role, services)).toBe("service");
      expect(acc.awsResourceProblem("arn:aws:dynamodb:us-east-1:222222222222:table/t1", role, services)).toBe("region");
      expect(acc.awsResourceProblem("arn:aws:dynamodb:us-west-2:111122223333:table/t1", role, services)).toBe("account");
      expect(acc.awsResourceProblem("arn:aws:dynamodb:us-west-2:222222222222:table/*", role, services)).toBe("wildcard");
      expect(acc.awsResourceProblem("arn:aws:s3:::*/*", role, services)).toBe("wildcard");
      expect(acc.awsResourceProblem("arn:aws:s3:::A/x", role, services)).toBe("bucket");
      expect(acc.awsResourceProblem("arn:aws:s3:::bucket-one/*", role, services)).toBeUndefined();
      expect(acc.awsResourceProblem("arn:aws:dynamodb:us-west-2:222222222222:table/t?", role, services)).toBe("fields");
      expect(acc.awsResourceProblem("not an arn", role, services)).toBe("fields");
    });
    it("holds the external id Rovara derives for the company and the account, and no other", () => {
      expect(acc.testAccountExternalId(ORG, "orders-dev")).toBe(`rovara-${ORG}-orders-dev`);
      expect(ok(awsAccount())).toBe(true);
      expect(ok(awsAccount({ aws: awsBlock({ externalId: acc.testAccountExternalId(ORG, "orders-dev") }) }))).toBe(true);
      // A customer's own value, another account's, and another company's are all refused, however well-formed.
      expect(ok(awsAccount({ aws: awsBlock({ externalId: "ext-0123456789" }) }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ externalId: acc.testAccountExternalId(ORG, "orders-files") }) }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ externalId: acc.testAccountExternalId(`org_${"z9y8x7w6v5".repeat(2)}`, "orders-dev") }) }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ externalId: "rovara-org_" }) }))).toBe(false);
      // It matches the condition the broker's grant carries (`sts:ExternalId` like `rovara-org_*`).
      expect(acc.testAccountExternalId(ORG, "orders-dev").startsWith("rovara-org_")).toBe(true);
      expect(acc.testAccountExternalId(ORG, "x".repeat(64)).length).toBeLessThanOrEqual(128);
      expect(ok(awsAccount({ aws: awsBlock({ region: "US_WEST" }) }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ actions: ["dynamodb:GetItem", "dynamodb:GetItem"] }) }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ resources: ["arn:aws:dynamodb:us-west-2:222222222222:table/t1", "arn:aws:dynamodb:us-west-2:222222222222:table/t1"] }) }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ actions: [] }) }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ resources: [] }) }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ actions: Array.from({ length: 21 }, (_, n) => `dynamodb:Op${String(n)}`) }) }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ resources: Array.from({ length: 21 }, (_, n) => `arn:aws:dynamodb:us-west-2:222222222222:table/t${String(n)}`) }) }))).toBe(false);
    });
    it("reaches exactly the regional endpoint of each service it approves, and has no variable of its own", () => {
      for (const host of ["dynamodb.us-east-1.amazonaws.com", "dynamodb.amazonaws.com", "api.example-pay.com", "evil-dynamodb.us-west-2.amazonaws.com.example.net", "evil.example.dynamodb.us-west-2.amazonaws.com", "dynamodb.us-west-2.amazonaws.com.cn"]) expect(ok(awsAccount({ hosts: [host] })), host).toBe(false);
      expect(ok(awsAccount({ hosts: ["dynamodb.us-west-2.amazonaws.com"] }))).toBe(true);
      expect(ok(awsAccount({ hosts: [] }))).toBe(false);
      expect(ok(awsAccount({ envNames: ["ORDERS_KEY"] }))).toBe(false);
    });
    it("lists the endpoints an account of given actions may reach", () => {
      expect(acc.testAccountAwsEndpointHosts({ region: "us-west-2", actions: ["dynamodb:GetItem", "dynamodb:PutItem", "s3:GetObject"] })).toEqual(["dynamodb.us-west-2.amazonaws.com", "s3.us-west-2.amazonaws.com"]);
      expect(acc.testAccountAwsEndpointHosts({ region: "eu-west-1", actions: ["sagemaker:InvokeEndpoint"] })).toEqual(["runtime.sagemaker.eu-west-1.amazonaws.com"]);
      expect(acc.testAccountAwsEndpointHosts({ region: "eu-west-1", actions: ["iam:PassRole"] })).toEqual([]);
    });
  });

  describe("hosts", () => {
    it("are at most 253 characters long", () => {
      const long = `${Array.from({ length: 4 }, () => "a".repeat(63)).join(".")}.com`;
      expect(long.length).toBeGreaterThan(253);
      expect(ok(account({ hosts: ["api.example-pay.com", long] }))).toBe(false);
    });
    it("are one to eight, each once", () => {
      expect(ok(account({ hosts: [] }))).toBe(false);
      expect(ok(account({ hosts: ["api.example-pay.com", "api.example-pay.com"] }))).toBe(false);
      expect(ok(account({ hosts: ["api.example-pay.com", ...Array.from({ length: 8 }, (_, n) => `h${String(n)}.example-pay.com`)] }))).toBe(false);
      expect(ok(account({ hosts: ["api.example-pay.com", ...Array.from({ length: 7 }, (_, n) => `h${String(n)}.example-pay.com`)] }))).toBe(true);
    });
  });

  describe("variables", () => {
    it("are names the test reads, not ones Rovara or the system owns, listed once, at most four", () => {
      for (const name of ["AWS_SECRET_ACCESS_KEY", "PATH", "HTTPS_PROXY", "NODE_OPTIONS", "LD_PRELOAD", "lower_case", ""]) expect(ok(account({ envNames: [name] })), name).toBe(false);
      expect(ok(account({ envNames: ["PAYMENTS_API_KEY", "PAYMENTS_API_KEY"] }))).toBe(false);
      expect(ok(account({ envNames: ["A", "B", "C", "D", "E"] }))).toBe(false);
      expect(ok(account({ envNames: [] }))).toBe(true);
    });
  });

  describe("limits", () => {
    it("have defaults and Rovara maximums", () => {
      expect(acc.TEST_ACCOUNT_LIMIT_DEFAULTS).toEqual({ maxConnectionsPerRun: 2_000, maxConnectionsPerDay: 20_000, maxConcurrentRounds: 2 });
      expect(acc.TEST_ACCOUNT_LIMIT_MAXIMUMS).toMatchObject({ maxConnectionsPerRun: 20_000, maxConcurrentRounds: 10 });
      expect(ok(account({ limits: acc.TEST_ACCOUNT_LIMIT_DEFAULTS }))).toBe(true);
    });
    it("keep a run's requests inside the day's", () => {
      expect(ok(account({ limits: { maxConnectionsPerRun: 5_000, maxConnectionsPerDay: 4_999, maxConcurrentRounds: 2 } }))).toBe(false);
      expect(ok(account({ limits: { maxConnectionsPerRun: 5_000, maxConnectionsPerDay: 5_000, maxConcurrentRounds: 2 } }))).toBe(true);
    });
  });

  describe("projects", () => {
    it("are all of them, or one to fifty named ones, each once", () => {
      expect(ok(account({ projectIds: "all" }))).toBe(true);
      expect(ok(account({ projectIds: [] }))).toBe(false);
      expect(ok(account({ projectIds: ["orders", "orders"] }))).toBe(false);
      expect(ok(account({ projectIds: Array.from({ length: 51 }, (_, n) => `p${String(n)}`) }))).toBe(false);
      expect(ok(account({ projectIds: Array.from({ length: 50 }, (_, n) => `p${String(n)}`) }))).toBe(true);
      expect(ok(account({ projectIds: ["Bad Name"] }))).toBe(false);
      expect(ok(account({ projectIds: "some" }))).toBe(false);
    });
  });

  describe("approval and expiry", () => {
    it("allows the sole-owner exception with one person", () => {
      expect(ok(account({ approvals: [approval("a", { kind: "sole_owner_exception" })] }))).toBe(true);
      expect(acc.testAccountApprovalsSatisfied([approval("a") as never])).toBe(false);
      expect(acc.testAccountApprovalsSatisfied([approval("a", { kind: "sole_owner_exception" }) as never])).toBe(true);
      expect(acc.testAccountApprovalsSatisfied([approval("a") as never, approval("b") as never])).toBe(true);
      expect(acc.testAccountApprovalsSatisfied([])).toBe(false);
    });
    it("expires an active account, after its last approval and within 90 days of it", () => {
      expect(acc.TEST_ACCOUNT_EXPIRY_DAYS).toEqual({ default: 90, max: 90, reminder: 14 });
      expect(ok(account({ expiresAt: undefined }))).toBe(false);
      expect(ok(account({ expiresAt: "2026-11-02T10:00:00.000Z" }))).toBe(false);
      expect(ok(account({ expiresAt: "2026-11-01T10:00:00.000Z" }))).toBe(false);
      expect(ok(account({ expiresAt: "2026-11-02T10:00:01.000Z" }))).toBe(true);
      // 90 days from 2026-11-02T10:00:00Z is 2027-01-31T10:00:00Z: the last allowed second.
      expect(ok(account({ expiresAt: "2027-01-31T10:00:00.000Z" }))).toBe(true);
      expect(ok(account({ expiresAt: "2027-01-31T10:00:01.000Z" }))).toBe(false);
      expect(ok(account({ expiresAt: "2027-11-02T10:00:00.000Z" }))).toBe(false);
    });
    it("lets a company set a shorter expiry, never a longer one", () => {
      const thirty = acc.testAccountSchemaFor({ maxExpiryDays: 30 });
      expect(thirty.safeParse(account({ expiresAt: "2026-12-02T10:00:00.000Z" })).success).toBe(true);
      expect(thirty.safeParse(account({ expiresAt: "2026-12-02T10:00:01.000Z" })).success).toBe(false);
      expect(acc.testAccountSchemaFor({ maxExpiryDays: 90 }).safeParse(account({ expiresAt: "2027-01-31T10:00:00.000Z" })).success).toBe(true);
      for (const days of [91, 365, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => acc.testAccountSchemaFor({ maxExpiryDays: days }), String(days)).toThrow(RangeError);
    });
  });

  describe("label", () => {
    it("is one plain line of at most 80 characters", () => {
      expect(ok(account({ label: "" }))).toBe(false);
      expect(ok(account({ label: "x".repeat(81) }))).toBe(false);
      expect(ok(account({ label: "two\nlines" }))).toBe(false);
    });
  });
});

describe("secret name, tags and reference", () => {
  it("builds the org-tagged path", () => {
    expect(acc.testAccountSecretName("staging", ORG, "payments-test")).toBe(`agentx/staging/org-test-accounts/${ORG}/payments-test`);
    expect(acc.testAccountSecretPrefix("staging", ORG)).toBe(`agentx/staging/org-test-accounts/${ORG}/`);
    expect(acc.testAccountSecretName("staging", ORG, "payments-test").startsWith(acc.testAccountSecretPrefix("staging", ORG))).toBe(true);
  });
  it("keeps test-account secrets apart from connector and hook secrets", () => {
    expect(acc.testAccountSecretName("staging", ORG, "x1")).not.toContain("org-connectors");
    expect(acc.testAccountSecretName("staging", ORG, "x1")).not.toContain("org-hooks");
    expect(acc.TEST_ACCOUNT_SECRET_SEGMENT).toBe("org-test-accounts");
  });
  it("tags the secret with its org and its use", () => {
    expect(acc.testAccountSecretTags(ORG)).toEqual({ "rovara:org": ORG, "rovara:use": "test-account" });
    expect(() => acc.testAccountSecretTags("org_short")).toThrow(RangeError);
  });
  it("takes a plain JSON key", () => {
    for (const key of ["", "a/b", "a:b", "1abc", "a b", "a}}", "x".repeat(65)]) expect(() => acc.testAccountSecretRef("staging", ORG, "payments-test", key), key).toThrow(RangeError);
    expect(() => acc.testAccountSecretRef("staging", ORG, "payments-test", "client_secret-2")).not.toThrow();
  });
  it("reads back only an exact test-account reference", () => {
    expect(acc.parseTestAccountSecretRef(`{{resolve:secretsmanager:agentx/staging/org-connectors/${ORG}/payments-test:SecretString:apiKey}}`)).toBeUndefined();
    expect(acc.parseTestAccountSecretRef(`agentx/staging/org-test-accounts/${ORG}/payments-test`)).toBeUndefined();
    expect(acc.parseTestAccountSecretRef(`prefix {{resolve:secretsmanager:agentx/staging/org-test-accounts/${ORG}/payments-test:SecretString:apiKey}}`)).toBeUndefined();
    expect(acc.parseTestAccountSecretRef(`{{resolve:secretsmanager:agentx/staging/org-test-accounts/org_short/payments-test:SecretString:apiKey}}`)).toBeUndefined();
    expect(acc.parseTestAccountSecretRef(`{{resolve:secretsmanager:agentx/staging/org-test-accounts/${ORG}/payments-test:SecretString:apiKey}}{{x}}`)).toBeUndefined();
    expect(acc.parseTestAccountSecretRef("")).toBeUndefined();
  });
});

describe("key-shape table", () => {
  const family = "http:api.stripe.com";
  const verdict = (value: string, fam = family) => acc.checkTestAccountKeyShape(fam, value);
  it("applies the vendor row by the family's host only", () => {
    expect(verdict(stripeTest(), "http:api.example-pay.com")).toEqual({ ok: true });
    expect(verdict("totally-plain-token-12345678", "http:api.example-pay.com")).toEqual({ ok: true });
    expect(verdict("totally-plain-token-12345678", "http:api.stripe.com.example.net")).toEqual({ ok: true });
    expect(verdict("totally-plain-token-12345678", "aws:dynamodb")).toEqual({ ok: true });
  });
  it("refuses a private key block, an empty value, an oversized one and a multi-line one", () => {
    expect(verdict(`${build("-----", "BEGIN RSA PRIVATE KEY", "-----")}\nabc`, "http:api.example-pay.com")).toEqual({ ok: false, code: "private_key_block" });
    expect(verdict("", "http:api.example-pay.com")).toEqual({ ok: false, code: "empty" });
    expect(verdict("a".repeat(4_097), "http:api.example-pay.com")).toEqual({ ok: false, code: "too_long" });
    expect(verdict("a".repeat(4_096), "http:api.example-pay.com")).toEqual({ ok: true });
    expect(verdict("abc\ndef", "http:api.example-pay.com")).toEqual({ ok: false, code: "not_one_line" });
    expect(verdict("abc​def", "http:api.example-pay.com")).toEqual({ ok: false, code: "not_one_line" });
  });
  it("never puts the value in the verdict", () => {
    for (const value of [stripeLive(), stripeTest().slice(0, 12), awsKeyId(), "plain-live-token"]) {
      const text = JSON.stringify(verdict(value));
      expect(text).not.toContain(value);
      expect(text).not.toContain(rand(10));
    }
  });
  it("lists the vendor rows it has, so a new row is a visible change", () => {
    expect(acc.TEST_ACCOUNT_VENDOR_KEY_RULES.length).toBe(1);
  });
});

describe("hosts that look like production", () => {
  const problems = (...hosts: string[]) => acc.testAccountHostProblems(hosts);
  it("refuses a vendor's production host where the vendor has a sandbox", () => {
    expect(problems("login.salesforce.com", "acme.my.salesforce.com", "api-m.paypal.com", "production.plaid.com", "api.plaid.com")).toEqual([0, 1, 2, 3, 4].map((index) => ({ index, code: "vendor_production_host" })));
  });
});

describe("production deny list", () => {
  const problemsOf = (value: Record<string, unknown>, list = deny({ hosts: ["*.prod.example.com"] }), options?: Parameters<typeof acc.testAccountProdProblems>[2]) => acc.testAccountProdProblems(parsed(value), list, options);
  it("finds nothing for a clean account", () => {
    expect(problemsOf(account())).toEqual([]);
    expect(problemsOf(awsAccount(), deny({ accountIds: ["111122223333"] }))).toEqual([]);
  });
  it("finds a host on the list, exact or by wildcard, with its position", () => {
    expect(problemsOf(account({ hosts: ["api.example-pay.com", "billing.internal.example.com"] }), deny({ hosts: ["*.internal.example.com"] }))).toEqual([{ kind: "prod_host", field: "hosts[1]" }]);
    expect(problemsOf(account({ hosts: ["api.example-pay.com", "billing.prod.example.com"] }))).toEqual([{ kind: "prod_host", field: "hosts[1]" }, { kind: "prod_shaped_host", field: "hosts[1]" }]);
    expect(problemsOf(account(), deny({ hosts: ["api.example-pay.com"] }))).toEqual([{ kind: "prod_host", field: "hosts[0]" }]);
    expect(problemsOf(account(), deny({ hosts: ["API.EXAMPLE-PAY.COM"] }))).toEqual([{ kind: "prod_host", field: "hosts[0]" }]);
  });
  it("finds a role and resources on the list by ARN prefix, and by account", () => {
    expect(problemsOf(awsAccount(), deny({ arnPrefixes: ["arn:aws:iam::222222222222:role/rovara-"] }))).toEqual([{ kind: "prod_arn", field: "aws.roleArn" }]);
    expect(problemsOf(awsAccount(), deny({ accountIds: ["222222222222"] }))).toEqual([{ kind: "prod_account", field: "aws.roleArn" }, { kind: "prod_account", field: "aws.resources[0]" }]);
    expect(problemsOf(awsAccount(), deny({ arnPrefixes: ["arn:aws:dynamodb:*:222222222222:table/orders-"] }))).toEqual([{ kind: "prod_arn", field: "aws.resources[0]" }]);
  });
  it("finds Rovara's own account", () => {
    expect(problemsOf(awsAccount(), deny({ accountIds: ["111122223333"] }), { rovaraAccountIds: ["222222222222"] })).toEqual([{ kind: "rovara_account", field: "aws.roleArn" }]);
    expect(problemsOf(awsAccount(), deny({ accountIds: ["111122223333"] }), { rovaraAccountIds: ["999988887777"] })).toEqual([]);
  });
  it("also reads the list the approved environment had, so removing an entry hides nothing", () => {
    const now = deny({ hosts: ["other.example.com"] });
    const before = deny({ hosts: ["api.example-pay.com"] });
    expect(problemsOf(account(), now)).toEqual([]);
    expect(problemsOf(account(), now, { alsoDeny: before })).toEqual([{ kind: "prod_host", field: "hosts[0]" }]);
    expect(problemsOf(account(), deny(), { alsoDeny: before })).toEqual([{ kind: "prod_host", field: "hosts[0]" }]);
    expect(problemsOf(account(), deny(), { alsoDeny: deny() })).toEqual([{ kind: "prod_deny_missing", field: "prodDeny" }]);
  });
});

describe("approvals cover what was approved", () => {
  it("has an approval schema that is strict and needs a 64-hex digest", () => {
    const one = { by: person("a"), at: "2026-11-02T10:00:00.000Z", freshSignIn: true, kind: "approver", approvedDigest: sha("e") };
    expect(acc.TestAccountApprovalSchema.safeParse(one).success).toBe(true);
    expect(acc.TestAccountApprovalSchema.safeParse(withoutDigest([one])[0]).success).toBe(false);
    for (const approvedDigest of ["", "abc", sha("A"), `${sha("e")}0`, sha("e").slice(1), `sha256:${sha("e")}`, 5, null]) expect(acc.TestAccountApprovalSchema.safeParse({ ...one, approvedDigest }).success, String(approvedDigest)).toBe(false);
    expect(acc.TestAccountApprovalSchema.safeParse({ ...one, extra: 1 }).success).toBe(false);
    expect(acc.TestAccountApprovalSchema.safeParse({ ...one, freshSignIn: false }).success).toBe(false);
  });
});

describe("the install's environment", () => {
  it("is part of what a secret reference may point at when the schema is made for an install", () => {
    const here = acc.testAccountSchemaFor({ env: "staging" });
    const elsewhere = acc.testAccountSchemaFor({ env: "prod-eu" });
    expect(here.safeParse(account()).success).toBe(true);
    expect(elsewhere.safeParse(account()).success).toBe(false);
    expect(acc.testAccountSchemaFor({ env: "staging" }).safeParse(account({ secretRef: ref({ env: "staging-two" }) })).success).toBe(false);
    expect(acc.TestAccountSchema.safeParse(account({ secretRef: ref({ env: "anything" }) })).success).toBe(true);
    // An AWS account has no secret reference, so the environment has nothing to refuse.
    expect(elsewhere.safeParse(awsAccount()).success).toBe(true);
  });
});

describe("isTestAccountUsableAt", () => {
  const record = () => parsed(account());
  const at = (when: string, over: Record<string, unknown> = {}, options?: Parameters<typeof acc.isTestAccountUsableAt>[2]) => acc.isTestAccountUsableAt({ ...record(), ...over }, when, options);
  it("is usable until its expiry and not at it", () => {
    expect(at("2026-11-03T00:00:00.000Z")).toBe(true);
    expect(at("2027-01-30T09:59:59.999Z")).toBe(true);
    expect(at("2027-01-30T10:00:00.000Z")).toBe(false);
    expect(at("2027-01-30T10:00:00.001Z")).toBe(false);
    expect(at("2030-01-01T00:00:00.000Z")).toBe(false);
  });
  it("takes a Date, a number or a string for now, and a date that is not a date is never usable", () => {
    const when = Date.parse("2026-11-03T00:00:00.000Z");
    expect(acc.isTestAccountUsableAt(record(), new Date(when))).toBe(true);
    expect(acc.isTestAccountUsableAt(record(), when)).toBe(true);
    expect(acc.isTestAccountUsableAt(record(), new Date(when).toISOString())).toBe(true);
    for (const bad of ["yesterday", "", Number.NaN, new Date(Number.NaN)]) expect(acc.isTestAccountUsableAt(record(), bad as never), String(bad)).toBe(false);
  });
  it("does not count an approval dated after now, nor an expiry computed from one", () => {
    const base = account({ status: "pending", expiresAt: undefined, approvals: [approval("a"), approval("b")] });
    const make = (approvals: Array<Record<string, unknown>>, expiresAt: string) => parsed(stamp({ ...base, status: "active", expiresAt, approvals }));
    // Two approvals today and a third in February. The third makes an expiry in May look like 90 days from its approval.
    const future = approval("c", { at: "2027-02-01T10:00:00.000Z" });
    const lateExpiry = "2027-05-01T10:00:00.000Z";
    const withFuture = make([approval("a"), approval("b"), future], lateExpiry);
    expect(acc.isTestAccountUsableAt(withFuture, "2026-11-03T00:00:00.000Z")).toBe(false);
    expect(acc.isTestAccountUsableAt(withFuture, "2027-02-01T09:59:59.999Z")).toBe(false);
    expect(acc.isTestAccountUsableAt(withFuture, "2027-02-01T10:00:00.000Z")).toBe(true);
    expect(acc.isTestAccountUsableAt(withFuture, "2027-04-30T10:00:00.000Z")).toBe(true);
    // The people come from approvals that have happened too: one that has not happened is not a second person.
    const secondInFuture = make([approval("a"), approval("b", { at: "2027-01-01T10:00:00.000Z" })], "2027-03-30T10:00:00.000Z");
    expect(acc.isTestAccountUsableAt(secondInFuture, "2026-11-03T00:00:00.000Z")).toBe(false);
    expect(acc.isTestAccountUsableAt(secondInFuture, "2027-01-01T10:00:00.000Z")).toBe(true);
  });
});

describe("environment variable names (shared rule)", () => {
  const prefixes = ["PYTHON", "NPM_CONFIG_", "PIP_", "UV_", "YARN_", "GO", "CARGO_", "XDG_", "SSL", "OPENSSL_", "GLIBC_", "GCONV_", "BASH", "KUBE", "GOOGLE_", "AZURE_", "ANTHROPIC_", "OPENAI_", "AGENTX_", "ROVARA_", "AWS_", "GIT_", "LD_", "DYLD_", "PI_", "DOCKER_"];
  const names = [
    "NODE_TLS_REJECT_UNAUTHORIZED", "SSLKEYLOGFILE", "HOSTALIASES", "TMPDIR", "PROMPT_COMMAND", "PS4", "SHELLOPTS", "FTP_PROXY", "MAVEN_OPTS", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "RUBYOPT", "PERL5OPT", "PERL5LIB",
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "OLDPWD", "IFS", "ENV", "BASH_ENV", "CLASSPATH", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "RUBYLIB", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "DOCKER_HOST",
  ];
  it.each(prefixes)("reserves every name starting %s", (prefix) => {
    for (const name of [`${prefix}X`, `${prefix}SOMETHING_ELSE`, `${prefix}1`]) {
      expect(shared.reservedDependencyEnvName(name), name).toBe(true);
      expect(shared.reservedDependencyEnvName(name.toLowerCase()), name.toLowerCase()).toBe(true);
    }
  });
  it.each(names)("reserves the name %s", (name) => {
    expect(shared.reservedDependencyEnvName(name)).toBe(true);
  });
});

describe("hosts that can be read as an address (shared host rule)", () => {
  const probes = ["127.1", "127.0.1", "10.1", "0x7f.0.0.1", "0177.0.0.1", "169.254.43518", "127.0.0.1", "10.0.0.1", "192.168.1.5", "1.1", "0x7f.1", "0x7f000001", "2130706433", "0x.0x", "a.1", "a.b.0x1", "a.0177", "1.2.3.4.5", "0.0.0.0", "localhost", "[::1]", "::1", "a.b.123"];
  it("refuses every short, hex, octal and dotted spelling of an address", () => {
    for (const host of probes) {
      expect(shared.hostProblem(host), host).toBeDefined();
      expect(shared.TestServiceHostSchema.safeParse(host).success, host).toBe(false);
      expect(ok(account({ hosts: ["api.example-pay.com", host] })), host).toBe(false);
    }
  });
});
