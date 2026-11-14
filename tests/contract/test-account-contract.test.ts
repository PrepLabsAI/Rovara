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
  it("accepts an active API-key account and round-trips it", () => {
    expect(acc.TestAccountSchema.parse(account())).toEqual(account());
  });
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
    it("must be a test-account reference at all", () => {
      for (const secretRef of ["", "plain-value", stripeTest(), "{{resolve:secretsmanager:agentx/staging/org-connectors/" + ORG + "/payments-test:SecretString:apiKey}}", "{{resolve:ssm:/x}}", "agentx/staging/org-test-accounts/x/y"]) expect(ok(account({ secretRef })), secretRef.slice(0, 20)).toBe(false);
    });
    it("must point at this org's own path", () => {
      expect(ok(account({ secretRef: ref({ org: OTHER_ORG }) }))).toBe(false);
    });
    it("must point at this account's own secret", () => {
      expect(ok(account({ secretRef: ref({ id: "someone-elses" }) }))).toBe(false);
    });
    it("is refused with extra segments or traversal", () => {
      const base = `{{resolve:secretsmanager:agentx/staging/org-test-accounts/${ORG}/payments-test:SecretString:apiKey}}`;
      expect(ok(account({ secretRef: base }))).toBe(true);
      for (const bad of [base.replace("payments-test", "payments-test/../x"), base.replace("/payments-test", "/a/payments-test"), base.replace("apiKey", "api/Key"), base.replace(":SecretString:apiKey", ""), `${base} `, ` ${base}`, base.replace("}}", ":v1}}"), base.replace("staging", "../staging")]) expect(ok(account({ secretRef: bad })), bad).toBe(false);
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
    it("lists the account's own host for an http family, and its own service's action for an AWS family", () => {
      expect(ok(account({ hosts: ["other.example-pay.com"] }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ actions: ["s3:GetObject"] }) }))).toBe(false);
      expect(ok(awsAccount({ family: "aws:sagemaker-runtime", aws: awsBlock({ actions: ["sagemaker:InvokeEndpoint"], resources: ["arn:aws:sagemaker:us-west-2:222222222222:endpoint/scorer"] }), hosts: ["runtime.sagemaker.us-west-2.amazonaws.com"] }))).toBe(true);
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
    it("refuses everything not on the list: access-granting, secrets, keys, parameters, code changes, instance access, control plane", () => {
      const refused = [
        "iam:PassRole", "iam:CreateRole", "iam:AttachRolePolicy", "sts:AssumeRole", "sts:GetFederationToken", "organizations:ListAccounts", "account:GetContactInformation", "sso:ListInstances", "identitystore:ListUsers",
        "s3:PutBucketPolicy", "s3:DeleteBucketPolicy", "s3:PutObjectAcl", "s3:PutBucketAcl", "s3:GetObjectAcl", "s3:GetBucketPolicy", "s3:PutAccessPointPolicy", "s3:DeleteBucket", "s3:CreateBucket", "s3:PutObjectTagging", "s3:GetObjectVersion",
        "dynamodb:PutResourcePolicy", "dynamodb:DeleteResourcePolicy", "dynamodb:CreateTable", "dynamodb:DeleteTable", "dynamodb:UpdateTable", "dynamodb:DescribeTable", "dynamodb:CreateBackup", "dynamodb:ExportTableToPointInTime",
        "sqs:AddPermission", "sqs:RemovePermission", "sqs:SetQueueAttributes", "sqs:CreateQueue", "sqs:DeleteQueue", "sqs:PurgeQueue",
        "sns:AddPermission", "sns:RemovePermission", "sns:SetTopicAttributes", "sns:Subscribe", "sns:CreateTopic", "sns:DeleteTopic",
        "kinesis:DeleteStream", "kinesis:CreateStream", "kinesis:PutResourcePolicy", "kinesis:RegisterStreamConsumer", "kinesis:UpdateShardCount",
        "events:PutPermission", "events:RemovePermission", "events:PutRule", "events:PutTargets", "events:CreateApiDestination",
        "secretsmanager:GetSecretValue", "secretsmanager:PutResourcePolicy", "secretsmanager:BatchGetSecretValue", "ssm:GetParameter", "ssm:GetParameters", "ssm:SendCommand", "ssm:StartSession",
        "kms:Decrypt", "kms:Encrypt", "kms:CreateGrant", "kms:PutKeyPolicy", "kms:GenerateDataKey",
        "lambda:InvokeFunction", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration", "lambda:AddPermission", "lambda:CreateFunction", "lambda:PublishLayerVersion",
        "ec2-instance-connect:SendSSHPublicKey", "ec2:RunInstances", "sagemaker:CreateEndpoint", "sagemaker:InvokeEndpointAsync", "sagemaker:CreatePresignedDomainUrl", "states:StartExecution", "cloudformation:CreateStack",
        "dynamodb:getitem", "DYNAMODB:GetItem", "dynamodb:GetItem ",
      ];
      for (const action of refused) expect(ok(awsAccount({ aws: awsBlock({ actions: ["dynamodb:GetItem", action] }) })), action).toBe(false);
      // Not even alone, in the account's own family.
      expect(ok(awsAccount({ aws: awsBlock({ actions: ["dynamodb:PutResourcePolicy"] }) }))).toBe(false);
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
    it("takes a role ARN, an external id and a region in their shapes, each list once and bounded", () => {
      expect(ok(awsAccount({ aws: awsBlock({ roleArn: "arn:aws:iam::222222222222:user/x" }) }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ externalId: "short" }) }))).toBe(false);
      expect(ok(awsAccount({ aws: awsBlock({ externalId: "has space in it" }) }))).toBe(false);
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
    it("refuses an endpoint of a service it did not approve, bucket subdomains, API-gateway hosts and other variants", () => {
      // dynamodb approved only: the s3 endpoint is another service's.
      expect(ok(awsAccount({ hosts: ["dynamodb.us-west-2.amazonaws.com", "s3.us-west-2.amazonaws.com"] }))).toBe(false);
      const both = (hosts: string[]) => s3Account({ aws: awsBlock({ actions: ["s3:GetObject", "dynamodb:GetItem"], resources: ["arn:aws:s3:::orders-test-bucket/*", "arn:aws:dynamodb:us-west-2:222222222222:table/orders-test"] }), hosts });
      expect(ok(both(["s3.us-west-2.amazonaws.com", "dynamodb.us-west-2.amazonaws.com"]))).toBe(true);
      for (const host of ["orders-test-bucket.s3.us-west-2.amazonaws.com", "s3.dualstack.us-west-2.amazonaws.com", "s3-fips.us-west-2.amazonaws.com", "s3.us-west-2.amazonaws.com.evil.example", "abc123.execute-api.us-west-2.amazonaws.com", "execute-api.us-west-2.amazonaws.com", "dynamodb-fips.us-west-2.amazonaws.com", "dynamodb.us-west-2.api.aws", "lambda.us-west-2.amazonaws.com", "s3.us-east-1.amazonaws.com", "s3.amazonaws.com"]) expect(ok(both(["s3.us-west-2.amazonaws.com", host])), host).toBe(false);
    });
    it("lists the endpoints an account of given actions may reach", () => {
      expect(acc.testAccountAwsEndpointHosts({ region: "us-west-2", actions: ["dynamodb:GetItem", "dynamodb:PutItem", "s3:GetObject"] })).toEqual(["dynamodb.us-west-2.amazonaws.com", "s3.us-west-2.amazonaws.com"]);
      expect(acc.testAccountAwsEndpointHosts({ region: "eu-west-1", actions: ["sagemaker:InvokeEndpoint"] })).toEqual(["runtime.sagemaker.eu-west-1.amazonaws.com"]);
      expect(acc.testAccountAwsEndpointHosts({ region: "eu-west-1", actions: ["iam:PassRole"] })).toEqual([]);
    });
  });

  describe("hosts", () => {
    it("are plain lower-case names: no address, wildcard, port, path, credentials or trailing dot", () => {
      for (const host of ["10.0.0.1", "192.168.1.5", "*.example-pay.com", "api.example-pay.com:443", "api.example-pay.com/v1", "user@api.example-pay.com", "api.example-pay.com.", "API.example-pay.com", "localhost", "https://api.example-pay.com", "a b.example.com", "-a.example.com", `${"a".repeat(64)}.example.com`]) expect(ok(account({ family: "http:api.example-pay.com", hosts: ["api.example-pay.com", host] })), host).toBe(false);
    });
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
    it("stop at the maximums and at 1", () => {
      expect(ok(account({ limits: { maxConnectionsPerRun: 20_000, maxConnectionsPerDay: 20_000, maxConcurrentRounds: 10 } }))).toBe(true);
      expect(ok(account({ limits: { maxConnectionsPerRun: 20_001, maxConnectionsPerDay: 100_000, maxConcurrentRounds: 2 } }))).toBe(false);
      expect(ok(account({ limits: { maxConnectionsPerRun: 100, maxConnectionsPerDay: 1_000, maxConcurrentRounds: 11 } }))).toBe(false);
      expect(ok(account({ limits: { maxConnectionsPerRun: 0, maxConnectionsPerDay: 1_000, maxConcurrentRounds: 2 } }))).toBe(false);
      expect(ok(account({ limits: { maxConnectionsPerRun: 100, maxConnectionsPerDay: 1_000, maxConcurrentRounds: 0 } }))).toBe(false);
      expect(ok(account({ limits: { maxConnectionsPerRun: 100, maxConnectionsPerDay: 1_000_001, maxConcurrentRounds: 2 } }))).toBe(false);
      expect(ok(account({ limits: { maxConnectionsPerRun: 1.5, maxConnectionsPerDay: 1_000, maxConcurrentRounds: 2 } }))).toBe(false);
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
    it("makes an account active only with two different people's approvals", () => {
      expect(ok(account({ approvals: [approval("a")] }))).toBe(false);
      expect(ok(account({ approvals: [approval("a"), approval("a")] }))).toBe(false);
      expect(ok(account({ approvals: [] }))).toBe(false);
      expect(ok(account({ approvals: [approval("a"), approval("b")] }))).toBe(true);
    });
    it("allows the sole-owner exception with one person", () => {
      expect(ok(account({ approvals: [approval("a", { kind: "sole_owner_exception" })] }))).toBe(true);
      expect(acc.testAccountApprovalsSatisfied([approval("a") as never])).toBe(false);
      expect(acc.testAccountApprovalsSatisfied([approval("a", { kind: "sole_owner_exception" }) as never])).toBe(true);
      expect(acc.testAccountApprovalsSatisfied([approval("a") as never, approval("b") as never])).toBe(true);
      expect(acc.testAccountApprovalsSatisfied([])).toBe(false);
    });
    it("needs every approval to carry a fresh sign-in", () => {
      expect(ok(account({ approvals: [approval("a"), approval("b", { freshSignIn: false })] }))).toBe(false);
      expect(ok(account({ approvals: [approval("a"), { by: person("b"), at: "2026-11-02T10:00:00.000Z", kind: "approver" }] }))).toBe(false);
      expect(ok(account({ approvals: [approval("a"), approval("b", { by: "short" })] }))).toBe(false);
      expect(ok(account({ approvals: Array.from({ length: 11 }, (_, n) => approval(String(n % 10), {})) }))).toBe(false);
    });
    it("lets a pending, suspended or expired account lack approvals", () => {
      for (const status of ["pending", "suspended", "expired"]) expect(ok(account({ status, approvals: [], expiresAt: undefined })), status).toBe(true);
      expect(ok(account({ status: "pending", approvals: [approval("a")], expiresAt: undefined }))).toBe(true);
      expect(ok(account({ status: "frozen" }))).toBe(false);
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
    it("has no window to measure for a record nobody has approved yet", () => {
      expect(ok(account({ status: "pending", approvals: [], expiresAt: "2030-01-01T00:00:00.000Z" }))).toBe(true);
      expect(ok(account({ status: "pending", approvals: [approval("a", { approvedDigest: sha("e") })], expiresAt: "2030-01-01T00:00:00.000Z" }))).toBe(true);
    });
    it("lets a company set a shorter expiry, never a longer one", () => {
      const thirty = acc.testAccountSchemaFor({ maxExpiryDays: 30 });
      expect(thirty.safeParse(account({ expiresAt: "2026-12-02T10:00:00.000Z" })).success).toBe(true);
      expect(thirty.safeParse(account({ expiresAt: "2026-12-02T10:00:01.000Z" })).success).toBe(false);
      expect(acc.testAccountSchemaFor({ maxExpiryDays: 90 }).safeParse(account({ expiresAt: "2027-01-31T10:00:00.000Z" })).success).toBe(true);
      for (const days of [91, 365, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => acc.testAccountSchemaFor({ maxExpiryDays: days }), String(days)).toThrow(RangeError);
    });
    it("measures the 90 days from the LATEST qualifying approval, and ignores a later approval of something else", () => {
      const later = approval("b", { at: "2026-12-02T10:00:00.000Z" });
      expect(ok(account({ approvals: [approval("a"), later], expiresAt: "2027-03-02T10:00:00.000Z" }))).toBe(true);
      expect(ok(account({ approvals: [later, approval("a")], expiresAt: "2027-03-02T10:00:01.000Z" }))).toBe(false);
      expect(ok(account({ approvals: [approval("a"), later], expiresAt: "2026-12-02T10:00:00.000Z" }))).toBe(false);
      // A third approval, much later, of an older version of the record does not move the window.
      const stale = approval("c", { at: "2026-12-30T10:00:00.000Z", approvedDigest: sha("e") });
      expect(ok(account({ approvals: [approval("a"), approval("b"), stale], expiresAt: "2027-01-31T10:00:00.000Z" }))).toBe(true);
      expect(ok(account({ approvals: [approval("a"), approval("b"), stale], expiresAt: "2027-02-01T10:00:00.000Z" }))).toBe(false);
    });
    it("takes dates as dates", () => {
      expect(ok(account({ expiresAt: "next year" }))).toBe(false);
      expect(ok(account({ rotatedAt: "2026-11-03T00:00:00.000Z", lastUsedAt: "2026-11-04T00:00:00.000Z" }))).toBe(true);
      expect(ok(account({ rotatedAt: "yesterday" }))).toBe(false);
    });
  });

  describe("label", () => {
    it("is one plain line of at most 80 characters", () => {
      expect(ok(account({ label: "" }))).toBe(false);
      expect(ok(account({ label: "x".repeat(81) }))).toBe(false);
      expect(ok(account({ label: "two\nlines" }))).toBe(false);
    });
    it("is never the place for a key: any key shape, live or test, is refused", () => {
      for (const label of [`Key ${stripeLive()}`, `Key ${stripeTest()}`, `Key ${awsKeyId()}`, `Key ${awsKeyId("ASIA")}`, `tok ${build("gh", "p_", rand(30))}`, `tok ${build("xox", "b-", rand(20))}`, `jwt ${build("ey", "J", rand(20), ".", rand(20), ".", rand(20))}`, `pem ${build("-----", "BEGIN")} x`, `long ${rand(40)}`]) expect(ok(account({ label })), label.slice(0, 10)).toBe(false);
      expect(ok(account({ label: "Payments sandbox for the orders service" }))).toBe(true);
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
  it("refuses any part that is not a plain segment, and never echoes it", () => {
    const bad: Array<[string, string, string]> = [["../x", ORG, "a1"], ["staging/x", ORG, "a1"], ["", ORG, "a1"], ["staging", "org_short", "a1"], ["staging", `${ORG}/..`, "a1"], ["staging", ORG, "../a1"], ["staging", ORG, "a/b"], ["staging", ORG, ""], ["staging", ORG, "A1"], ["staging", ORG, "a1\n"], ["staging", ORG, "a".repeat(65)], ["x".repeat(33), ORG, "a1"], ["st aging", ORG, "a1"]];
    for (const [env, org, id] of bad) {
      expect(() => acc.testAccountSecretName(env, org, id), `${env}|${org}|${id}`).toThrow(RangeError);
      try {
        acc.testAccountSecretName(env, org, id);
      } catch (error) {
        expect(String(error)).not.toContain("..");
        expect(String(error)).not.toContain(org === ORG ? "org_a1" : "\u0000never");
      }
    }
    expect(() => acc.testAccountSecretPrefix("staging", "org_short")).toThrow(RangeError);
    expect(() => acc.testAccountSecretPrefix("../x", ORG)).toThrow(RangeError);
  });
  it("builds a resolve reference and reads it back", () => {
    const reference = acc.testAccountSecretRef("staging", ORG, "payments-test", "apiKey");
    expect(reference).toBe(`{{resolve:secretsmanager:agentx/staging/org-test-accounts/${ORG}/payments-test:SecretString:apiKey}}`);
    expect(acc.parseTestAccountSecretRef(reference)).toEqual({ env: "staging", orgId: ORG, accountId: "payments-test", key: "apiKey" });
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
  it("accepts a vendor's test key and refuses its live key", () => {
    expect(verdict(stripeTest())).toEqual({ ok: true });
    expect(verdict(stripeLive())).toEqual({ ok: false, code: "live_shaped" });
    for (const prefix of ["rk", "pk"]) {
      expect(verdict(build(prefix, "_test_", rand(24)))).toEqual({ ok: true });
      expect(verdict(build(prefix, "_live_", rand(24)))).toEqual({ ok: false, code: "live_shaped" });
    }
  });
  it("accepts only the test shape where the vendor has one", () => {
    expect(verdict("totally-plain-token-12345678")).toEqual({ ok: false, code: "not_test_shaped" });
    expect(verdict(build("sk", "_test_", "short"))).toEqual({ ok: false, code: "not_test_shaped" });
    expect(verdict(` ${stripeTest()}`)).toEqual({ ok: false, code: "not_test_shaped" });
    expect(verdict(build("xx", stripeTest()))).toEqual({ ok: false, code: "not_test_shaped" });
  });
  it("refuses a live key whatever it is embedded in", () => {
    expect(verdict(`Bearer ${stripeLive()}`)).toEqual({ ok: false, code: "live_shaped" });
    expect(verdict(`${stripeTest()} ${stripeLive()}`)).toEqual({ ok: false, code: "live_shaped" });
    expect(verdict(`key=${stripeLive()}`)).toEqual({ ok: false, code: "live_shaped" });
  });
  it("applies the vendor row by the family's host only", () => {
    expect(verdict(stripeTest(), "http:api.example-pay.com")).toEqual({ ok: true });
    expect(verdict("totally-plain-token-12345678", "http:api.example-pay.com")).toEqual({ ok: true });
    expect(verdict("totally-plain-token-12345678", "http:api.stripe.com.example.net")).toEqual({ ok: true });
    expect(verdict("totally-plain-token-12345678", "aws:dynamodb")).toEqual({ ok: true });
  });
  it("refuses a live word in any family", () => {
    for (const value of ["live_abc123def456", "abc-live-abc123", "my.prod.token", "PROD-key-1", "token_production_x", "key:PRD:1", "x live"]) expect(verdict(value, "http:api.example-pay.com"), value).toEqual({ ok: false, code: "live_shaped" });
    for (const value of ["alive123", "delivery-key", "product-7", "olive_oil_9", "prodigy"]) expect(verdict(value, "http:api.example-pay.com"), value).toEqual({ ok: true });
  });
  it("refuses a long-lived AWS key id in any family, and a session key id too", () => {
    for (const prefix of ["AKIA", "ASIA", "AIDA", "AROA", "ABIA", "ACCA"]) expect(verdict(awsKeyId(prefix), "http:api.example-pay.com"), prefix).toEqual({ ok: false, code: "long_lived_aws_key" });
    expect(verdict(`id=${awsKeyId()};x`, "aws:dynamodb")).toEqual({ ok: false, code: "long_lived_aws_key" });
    expect(verdict(build("AKIA", "SHORT"), "http:api.example-pay.com")).toEqual({ ok: true });
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

describe("looksLikeSecretValue", () => {
  it("finds each specific shape even when it is too short for the generic long-token rule", () => {
    for (const text of [build("sk", "_", "live", "_", rand(10)), build("sk", "_", "test", "_", rand(10)), build("gh", "o_", rand(20)), build("github", "_pat_", rand(20)), build("xox", "a-", rand(10)), build("ey", "J", rand(10), ".", rand(10), ".", rand(10))]) {
      // No run of token characters reaches 32 (dots break the JWT's runs), so only the specific rule can find it.
      expect(Math.max(...text.split(".").map((part) => part.length)), text.slice(0, 8)).toBeLessThan(32);
      expect(shared.looksLikeSecretValue(`note ${text}`), text.slice(0, 8)).toBe(true);
    }
  });
  it("finds every known shape, live or test", () => {
    for (const text of [stripeLive(), stripeTest(), awsKeyId(), awsKeyId("ASIA"), build("gh", "p_", rand(30)), build("gh", "s_", rand(30)), build("github", "_pat_", rand(30)), build("xox", "p-", rand(20)), build("ey", "J", rand(20), ".", rand(20), ".", rand(20)), build("-----", "BEGIN PRIVATE KEY"), rand(40)]) expect(shared.looksLikeSecretValue(`note: ${text}`), text.slice(0, 8)).toBe(true);
  });
  it("leaves ordinary words alone", () => {
    for (const text of ["Payments test mode", "Dev AWS (orders)", "CRM sandbox for the orders-service", "ABC-123", "a".repeat(31)]) expect(shared.looksLikeSecretValue(text), text).toBe(false);
  });
});

describe("hosts that look like production", () => {
  const problems = (...hosts: string[]) => acc.testAccountHostProblems(hosts);
  it("refuses a vendor's production host where the vendor has a sandbox", () => {
    expect(problems("login.salesforce.com", "acme.my.salesforce.com", "api-m.paypal.com", "production.plaid.com", "api.plaid.com")).toEqual([0, 1, 2, 3, 4].map((index) => ({ index, code: "vendor_production_host" })));
  });
  it("accepts the vendor's sandbox hosts", () => {
    expect(problems("test.salesforce.com", "acme--uat.sandbox.my.salesforce.com", "acme.scratch.my.salesforce.com", "api-m.sandbox.paypal.com", "sandbox.paypal.com", "sandbox.plaid.com")).toEqual([]);
  });
  it("does not take a look-alike for the vendor, or the vendor for a look-alike", () => {
    expect(problems("salesforce.com.example.net", "notsalesforce.com", "paypal.com.evil.example")).toEqual([]);
    expect(problems("salesforce.com")).toEqual([{ index: 0, code: "vendor_production_host" }]);
    expect(problems("PayPal.com")).toEqual([{ index: 0, code: "vendor_production_host" }]);
  });
  it("refuses a name with a prod or live label", () => {
    expect(problems("api.prod.example.com", "prod.example.com", "live.example.com", "api.production.example.com", "api.prd.example.com", "api.example.com.prod")).toEqual([0, 1, 2, 3, 4, 5].map((index) => ({ index, code: "prod_shaped_host" })));
    expect(problems("api.product.example.com", "api.delivery.example.com", "api.example-prod.com", "api.alive.example.com", "api.sandbox.example.com")).toEqual([]);
  });
  it("returns positions and codes only", () => {
    expect(JSON.stringify(problems("ok.example.com", "login.salesforce.com"))).toBe('[{"index":1,"code":"vendor_production_host"}]');
  });
});

describe("production deny list", () => {
  const problemsOf = (value: Record<string, unknown>, list = deny({ hosts: ["*.prod.example.com"] }), options?: Parameters<typeof acc.testAccountProdProblems>[2]) => acc.testAccountProdProblems(parsed(value), list, options);
  it("finds nothing for a clean account", () => {
    expect(problemsOf(account())).toEqual([]);
    expect(problemsOf(awsAccount(), deny({ accountIds: ["111122223333"] }))).toEqual([]);
  });
  it("refuses an account while the company has listed nothing as production", () => {
    expect(problemsOf(account(), deny())).toEqual([{ kind: "prod_deny_missing", field: "prodDeny" }]);
    expect(problemsOf(awsAccount(), deny())).toEqual([{ kind: "prod_deny_missing", field: "prodDeny" }]);
  });
  it("finds a host on the list, exact or by wildcard, with its position", () => {
    expect(problemsOf(account({ hosts: ["api.example-pay.com", "billing.internal.example.com"] }), deny({ hosts: ["*.internal.example.com"] }))).toEqual([{ kind: "prod_host", field: "hosts[1]" }]);
    expect(problemsOf(account({ hosts: ["api.example-pay.com", "billing.prod.example.com"] }))).toEqual([{ kind: "prod_host", field: "hosts[1]" }, { kind: "prod_shaped_host", field: "hosts[1]" }]);
    expect(problemsOf(account(), deny({ hosts: ["api.example-pay.com"] }))).toEqual([{ kind: "prod_host", field: "hosts[0]" }]);
    expect(problemsOf(account(), deny({ hosts: ["API.EXAMPLE-PAY.COM"] }))).toEqual([{ kind: "prod_host", field: "hosts[0]" }]);
  });
  it("finds a host that looks like production although the list does not name it", () => {
    expect(problemsOf(account({ family: "http:login.salesforce.com", hosts: ["login.salesforce.com"] }))).toEqual([{ kind: "vendor_production_host", field: "hosts[0]" }]);
    expect(problemsOf(account({ family: "http:api.prod.shop.example.org", hosts: ["api.prod.shop.example.org"] }))).toEqual([{ kind: "prod_shaped_host", field: "hosts[0]" }]);
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
  it("returns kinds and fields only, never the host or ARN", () => {
    const text = JSON.stringify(problemsOf(awsAccount({ hosts: ["dynamodb.us-west-2.amazonaws.com"] }), deny({ accountIds: ["222222222222"], hosts: ["dynamodb.us-west-2.amazonaws.com"] })));
    expect(text).not.toContain("222222222222");
    expect(text).not.toContain("amazonaws");
  });
});

describe("approvals cover what was approved", () => {
  const staleDigest = sha("e");
  it("binds each approval to the digest of family, hosts, AWS block, variables, projects, limits and secret reference", () => {
    const base = parsed(account());
    const digest = acc.testAccountApprovalDigest(base);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    const changed: Array<[string, Record<string, unknown>]> = [
      ["family", { family: "http:api.other-pay.com", hosts: ["api.other-pay.com"] }],
      ["hosts", { hosts: ["api.example-pay.com", "extra.example-pay.com"] }],
      ["envNames", { envNames: ["PAYMENTS_API_KEY", "OTHER_KEY"] }],
      ["projectIds", { projectIds: ["orders", "billing", "reports"] }],
      ["projectIds all", { projectIds: "all" }],
      ["limits run", { limits: { maxConnectionsPerRun: 2_001, maxConnectionsPerDay: 20_000, maxConcurrentRounds: 2 } }],
      ["limits day", { limits: { maxConnectionsPerRun: 2_000, maxConnectionsPerDay: 20_001, maxConcurrentRounds: 2 } }],
      ["limits rounds", { limits: { maxConnectionsPerRun: 2_000, maxConnectionsPerDay: 20_000, maxConcurrentRounds: 3 } }],
      ["secretRef", { secretRef: ref({ key: "other" }) }],
      ["kind", { kind: "basic" }],
      ["id", { id: "payments-test-two", secretRef: ref({ id: "payments-test-two" }) }],
      ["orgId", { orgId: OTHER_ORG, secretRef: ref({ org: OTHER_ORG }) }],
    ];
    for (const [what, over] of changed) expect(acc.testAccountApprovalDigest({ ...base, ...over }), what).not.toBe(digest);
    // The family alone, with the hosts held the same.
    const twoHosts = { ...base, hosts: ["api.example-pay.com", "api.other-pay.com"] };
    expect(acc.testAccountApprovalDigest({ ...twoHosts, family: "http:api.other-pay.com" })).not.toBe(acc.testAccountApprovalDigest(twoHosts));
    const aws = parsed(awsAccount());
    const awsDigest = acc.testAccountApprovalDigest(aws);
    const awsChanged: Array<[string, Record<string, unknown>]> = [
      ["roleArn", { roleArn: "arn:aws:iam::222222222222:role/other" }],
      ["externalId", { externalId: "ext-9999999999" }],
      ["region", { region: "us-east-1" }],
      ["actions", { actions: ["dynamodb:GetItem"] }],
      ["resources", { resources: ["arn:aws:dynamodb:us-west-2:222222222222:table/other"] }],
    ];
    for (const [what, over] of awsChanged) expect(acc.testAccountApprovalDigest({ ...aws, aws: { ...aws.aws!, ...over } }), what).not.toBe(awsDigest);
  });
  it("is the same for a re-ordered list and unaffected by fields an approval does not cover", () => {
    const base = parsed(account());
    const digest = acc.testAccountApprovalDigest(base);
    expect(acc.testAccountApprovalDigest({ ...base, projectIds: ["billing", "orders"] })).toBe(digest);
    expect(acc.testAccountApprovalDigest({ ...base, label: "Another label", status: "suspended", expiresAt: "2030-01-01T00:00:00.000Z", rotatedAt: "2026-11-05T00:00:00.000Z", lastUsedAt: "2026-11-06T00:00:00.000Z", approvals: [] } as never)).toBe(digest);
    const aws = parsed(awsAccount({ aws: awsBlock({ actions: ["dynamodb:GetItem", "dynamodb:PutItem"], resources: ["arn:aws:dynamodb:us-west-2:222222222222:table/a1", "arn:aws:dynamodb:us-west-2:222222222222:table/b1"] }) }));
    const reordered = { ...aws, aws: { ...aws.aws!, actions: [...aws.aws!.actions].reverse(), resources: [...aws.aws!.resources].reverse() } };
    expect(acc.testAccountApprovalDigest(reordered as never)).toBe(acc.testAccountApprovalDigest(aws));
  });
  it("ties approvals to this account in this org, even for a role-only AWS account with no secret reference", () => {
    const approved = parsed(awsAccount());
    expect(ok(approved)).toBe(true);
    // The external id follows the account (it is derived from the company and the id), so a copy under another id or org carries its own.
    const otherId = { ...approved, id: "orders-dev-two", aws: { ...approved.aws!, externalId: acc.testAccountExternalId(ORG, "orders-dev-two") } };
    const otherOrg = { ...approved, orgId: OTHER_ORG, aws: { ...approved.aws!, externalId: acc.testAccountExternalId(OTHER_ORG, "orders-dev") } };
    // Everything the approvers saw is the same; only whose account it is differs.
    expect(acc.testAccountApprovalDigest(otherId)).not.toBe(acc.testAccountApprovalDigest(approved));
    expect(acc.testAccountApprovalDigest(otherOrg)).not.toBe(acc.testAccountApprovalDigest(approved));
    expect(ok(otherId)).toBe(false);
    expect(ok(otherOrg)).toBe(false);
    expect(acc.testAccountQualifyingApprovals(otherId)).toEqual([]);
    expect(acc.testAccountQualifyingApprovals(otherOrg)).toEqual([]);
    expect(acc.testAccountQualifyingApprovals(approved)).toHaveLength(2);
    // The same fields under another id or org count once approved there.
    expect(ok(stamp({ ...otherId, approvals: withoutDigest(otherId.approvals) }))).toBe(true);
    expect(ok(stamp({ ...otherOrg, approvals: withoutDigest(otherOrg.approvals) }))).toBe(true);
    // The same holds for an account with a secret reference.
    const withSecret = parsed(account());
    expect(ok({ ...withSecret, id: "payments-test-two", secretRef: ref({ id: "payments-test-two" }) })).toBe(false);
  });
  it("needs every approval to carry the digest, in its shape", () => {
    const without = account();
    expect(ok({ ...without, approvals: withoutDigest(without.approvals) })).toBe(false);
    for (const approvedDigest of ["", "abc", sha("A"), `${sha("e")}0`]) expect(ok(account({ approvals: [approval("a", { approvedDigest }), approval("b", { approvedDigest })] })), approvedDigest).toBe(false);
  });
  it("has an approval schema that is strict and needs a 64-hex digest", () => {
    const one = { by: person("a"), at: "2026-11-02T10:00:00.000Z", freshSignIn: true, kind: "approver", approvedDigest: sha("e") };
    expect(acc.TestAccountApprovalSchema.safeParse(one).success).toBe(true);
    expect(acc.TestAccountApprovalSchema.safeParse(withoutDigest([one])[0]).success).toBe(false);
    for (const approvedDigest of ["", "abc", sha("A"), `${sha("e")}0`, sha("e").slice(1), `sha256:${sha("e")}`, 5, null]) expect(acc.TestAccountApprovalSchema.safeParse({ ...one, approvedDigest }).success, String(approvedDigest)).toBe(false);
    expect(acc.TestAccountApprovalSchema.safeParse({ ...one, extra: 1 }).success).toBe(false);
    expect(acc.TestAccountApprovalSchema.safeParse({ ...one, freshSignIn: false }).success).toBe(false);
  });
  it("counts only approvals of exactly this record: a stale approval is no approval", () => {
    expect(ok(account({ approvals: [approval("a"), approval("b", { approvedDigest: staleDigest })] }))).toBe(false);
    expect(ok(account({ approvals: [approval("a", { approvedDigest: staleDigest }), approval("b", { approvedDigest: staleDigest })] }))).toBe(false);
    expect(ok(account({ approvals: [approval("a"), approval("b"), approval("c", { approvedDigest: staleDigest })] }))).toBe(true);
    const record = parsed(account({ status: "pending", expiresAt: undefined, approvals: [approval("a"), approval("b", { approvedDigest: staleDigest })] }));
    expect(acc.testAccountQualifyingApprovals(record).map((each) => each.by)).toEqual([person("a")]);
  });
  it("applies to the sole-owner exception too", () => {
    expect(ok(account({ approvals: [approval("a", { kind: "sole_owner_exception" })] }))).toBe(true);
    expect(ok(account({ approvals: [approval("a", { kind: "sole_owner_exception", approvedDigest: staleDigest })] }))).toBe(false);
    expect(ok(account({ approvals: [approval("a", { kind: "sole_owner_exception", approvedDigest: staleDigest }), approval("b")] }))).toBe(false);
  });
  it("needs fresh approvals when a record is widened", () => {
    const approved = parsed(account());
    expect(ok(approved)).toBe(true);
    const widenings: Array<[string, Record<string, unknown>]> = [
      ["a host", { hosts: ["api.example-pay.com", "billing.example-pay.com"] }],
      ["a project", { projectIds: [...(approved.projectIds as string[]), "reports"] }],
      ["all projects", { projectIds: "all" }],
      ["a request limit", { limits: { ...approved.limits, maxConnectionsPerRun: 5_000 } }],
      ["a variable", { envNames: [...approved.envNames, "EXTRA_VALUE"] }],
      ["the secret", { secretRef: ref({ key: "otherKey" }) }],
    ];
    for (const [what, over] of widenings) {
      const widened = { ...approved, ...over };
      expect(ok(widened), `${what}: old approvals`).toBe(false);
      // The same people approving the widened record count.
      expect(ok(stamp({ ...widened, approvals: withoutDigest(widened.approvals) })), `${what}: fresh approvals`).toBe(true);
    }
    const awsApproved = parsed(awsAccount());
    expect(ok(awsApproved)).toBe(true);
    expect(ok({ ...awsApproved, aws: { ...awsApproved.aws!, actions: [...awsApproved.aws!.actions, "dynamodb:DeleteItem"] } })).toBe(false);
    expect(ok({ ...awsApproved, aws: { ...awsApproved.aws!, resources: [...awsApproved.aws!.resources, "arn:aws:dynamodb:us-west-2:222222222222:table/other-table"] } })).toBe(false);
    expect(ok({ ...awsApproved, aws: { ...awsApproved.aws!, region: "us-east-1" }, hosts: ["dynamodb.us-east-1.amazonaws.com"] })).toBe(false);
  });
  it("lets a label, status or date change without new approvals", () => {
    const approved = parsed(account());
    expect(ok({ ...approved, label: "Renamed", lastUsedAt: "2026-11-05T00:00:00.000Z", rotatedAt: "2026-11-04T00:00:00.000Z" })).toBe(true);
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
  it("keeps the milliseconds of a Date it is given", () => {
    const withMillis = { ...record(), expiresAt: "2027-01-30T10:00:00.500Z" };
    expect(acc.isTestAccountUsableAt(withMillis, new Date("2027-01-30T10:00:00.400Z"))).toBe(true);
    expect(acc.isTestAccountUsableAt(withMillis, new Date("2027-01-30T10:00:00.700Z"))).toBe(false);
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
  it("counts an approval from now on, not before, and never one whose date is not a date", () => {
    const record = parsed(account());
    const first = Date.parse("2026-11-02T10:00:00.000Z");
    expect(acc.testAccountQualifyingApprovals(record, first - 1)).toEqual([]);
    expect(acc.testAccountQualifyingApprovals(record, first)).toHaveLength(2);
    expect(acc.testAccountQualifyingApprovals(record)).toHaveLength(2);
    const broken = { ...record, approvals: record.approvals.map((each) => ({ ...each, at: "never" })) };
    expect(acc.testAccountQualifyingApprovals(broken, first)).toEqual([]);
    expect(acc.testAccountQualifyingApprovals(broken)).toHaveLength(2);
  });
  it("is not usable unless active", () => {
    for (const status of ["pending", "suspended", "expired"]) expect(at("2026-11-03T00:00:00.000Z", { status }), status).toBe(false);
  });
  it("is not usable without an expiry", () => {
    expect(at("2026-11-03T00:00:00.000Z", { expiresAt: undefined })).toBe(false);
    expect(at("2026-11-03T00:00:00.000Z", { expiresAt: "soon" })).toBe(false);
  });
  it("is not usable when its approvals no longer cover the record (a record that did not come through the schema)", () => {
    expect(at("2026-11-03T00:00:00.000Z", { hosts: ["api.example-pay.com", "extra.example-pay.com"] })).toBe(false);
    expect(at("2026-11-03T00:00:00.000Z", { approvals: [] })).toBe(false);
    expect(at("2026-11-03T00:00:00.000Z", { approvals: [(record().approvals)[0]!] })).toBe(false);
  });
  it("is not usable when its expiry is further out than the allowed days", () => {
    expect(at("2026-11-03T00:00:00.000Z", { expiresAt: "2027-01-31T10:00:00.000Z" })).toBe(true);
    expect(at("2026-11-03T00:00:00.000Z", { expiresAt: "2027-01-31T10:00:01.000Z" })).toBe(false);
    expect(at("2026-11-03T00:00:00.000Z", {}, { maxExpiryDays: 30 })).toBe(false);
    expect(() => at("2026-11-03T00:00:00.000Z", {}, { maxExpiryDays: 120 })).toThrow(RangeError);
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
  it("refuses each reserved name as a test account's variable", () => {
    for (const name of [...names, ...prefixes.map((prefix) => `${prefix}FOO`)]) if (/^[A-Z][A-Z0-9_]{0,63}$/u.test(name)) expect(ok(account({ envNames: [name] })), name).toBe(false);
  });
  it("reserves the loader, runtime, shell-helper and credential-agent names that were missing", () => {
    for (const name of ["ECS_CONTAINER_METADATA_URI", "SSH_AUTH_SOCK", "SSH_ASKPASS", "DOTNET_STARTUP_HOOKS", "COREHOST_TRACE", "CORECLR_ENABLE_PROFILING", "COMPLUS_X", "LC_ALL", "LANG", "MALLOC_CONF", "JAVA_OPTS", "GRADLE_OPTS", "SBT_OPTS", "EDITOR", "VISUAL", "PAGER", "BROWSER", "LESSOPEN", "HISTFILE", "LOCPATH", "NLSPATH"]) {
      expect(shared.reservedDependencyEnvName(name), name).toBe(true);
      expect(ok(account({ envNames: [name] })), name).toBe(false);
    }
  });
  it("leaves ordinary names alone", () => {
    for (const name of ["DATABASE_URL", "REDIS_URL", "PAYMENTS_API_KEY", "PAYMENTS_API_URL", "CRM_TOKEN", "STRIPE_KEY", "DB_PASSWORD", "AMQP_URL", "ORDERS_ENDPOINT"]) {
      expect(shared.reservedDependencyEnvName(name), name).toBe(false);
      expect(ok(account({ envNames: [name] })), name).toBe(true);
    }
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
  it("refuses them as a test account's only host and as its own family's host", () => {
    for (const host of ["127.1", "0x7f.0.0.1", "169.254.43518"]) expect(ok(account({ family: `http:${host}`, hosts: [host] })), host).toBe(false);
  });
  it("accepts ordinary names, including ones with digits and hyphens", () => {
    for (const host of ["api.example-pay.com", "a.io", "sandbox.api2.example.com", "xn--p1ai.xn--p1ai", "1password.example.com", "api-1.example.org", "x.dev"]) {
      expect(shared.hostProblem(host), host).toBeUndefined();
      expect(shared.TestServiceHostSchema.safeParse(host).success, host).toBe(true);
    }
  });
  it("refuses a last label that does not start with a letter, whatever else it is", () => {
    for (const host of ["foo.1a", "api.example.123abc", "api.example.9", "api.example.0x", "a.b.1e5"]) {
      expect(shared.hostProblem(host), host).toBe("numeric_label");
      expect(ok(account({ hosts: ["api.example-pay.com", host] })), host).toBe(false);
    }
  });
  it("says why, in fixed codes", () => {
    expect(shared.hostProblem("0x7f.0x1")).toBe("address_shaped");
    expect(shared.hostProblem("0177.0.0.1")).toBe("address_shaped");
    expect(shared.hostProblem("127.1")).toBe("address_shaped");
    expect(shared.hostProblem("api.example.0x1")).toBe("numeric_label");
    expect(shared.hostProblem("localhost")).toBe("single_label");
    expect(shared.hostProblem("Api.example.com")).toBe("shape");
    expect(shared.hostProblem("")).toBe("shape");
    expect(shared.hostProblem("a".repeat(254))).toBe("shape");
  });
});
