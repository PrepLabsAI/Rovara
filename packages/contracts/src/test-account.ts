// Test services, TS4 (design test-services.md, 4.3 and 6): a TEST ACCOUNT is the customer's own non-production account for a service (a payment provider's test mode, a CRM sandbox, a dev AWS account, a
// pre-prod endpoint). It is used only by sealed check rounds, through a proxy limited to its hosts. This is the contract only: nothing stores, approves or uses an account yet.
//
// What this module guarantees, so no builder has to remember it:
//   - REFERENCE ONLY. A record holds the name of an org-tagged Secrets Manager secret (a `{{resolve:secretsmanager:...}}` reference), never a value. The schema is strict (no `value`, `secret` or `token`
//     member exists), the reference must point at THIS account's own path under THIS org, and a label that looks like a key is refused. The functions here return fixed codes and field names, never the text
//     they checked;
//   - the secret's name is built in one place (`testAccountSecretName`), org-tagged, from parts that cannot climb out of their path;
//   - a value that looks like a live or production key is refused (`checkTestAccountKeyShape`): by the vendor's own live prefix, by a live/prod word, as a long-lived AWS access key (an AWS account is reached
//     by a role, never a stored key) or as a private-key block; and where the vendor has a test shape, only that shape is accepted;
//   - a host is a plain lower-case name that can never be read as an address (never a wildcard, a port, or a short or hex spelling of an IP: one rule, shared with dependency families); an AWS account's
//     hosts are exactly the regional endpoints of the services it approves; a vendor's production host is refused where the vendor has a sandbox host (`testAccountHostProblems`);
//   - an AWS account is a role, with actions from a fail-closed data-plane allow-list (`TEST_ACCOUNT_AWS_ACTIONS`) and resources that name what they cover, in the role's own partition, region and account;
//   - a host is never an AI model service (FIX-0518): the schema refuses a catalog model host, its Azure suffix forms, any case and a trailing dot, with one fixed sentence, and `testAccountProdProblems` finds one in a
//     stored record at use time (`test-account-model-hosts.ts`);
//   - every host, role and resource is checked against the production deny list, and an account may not be used while the list is empty (`testAccountProdProblems`);
//   - an account is active only with two distinct people's fresh-sign-in approvals, or the sole-owner exception, each approving exactly this record (an approval carries the digest of what it approved,
//     so widening a record needs fresh approvals), and then only until an expiry at most 90 days after the last such approval (a company may set fewer days, never more).
// Nothing here imports a Node module.
import { z } from "zod";
import { OrgIdSchema } from "./browser-ids.js";
import { canonicalJson } from "./canonical-json.js";
import { EnvNameSchema, FamilyIdSchema, TestAccountIdSchema, TestEnvRegionSchema } from "./test-env-dependency.js";
import { AWS_KEY_ID, TestServiceHostSchema, looksLikeSecretValue, reservedDependencyEnvName } from "./test-services-shared.js";
import { normalizeDenyHost, prodDenyIsEmpty, prodDenyMatchesArn, prodDenyMatchesHost, type TestEnvProdDeny } from "./test-environment-prod-deny.js";
import { sha256Hex } from "./web-hash.js";
import { TEST_ACCOUNT_MODEL_HOST_SENTENCE, isTestAccountModelHost, testAccountModelHostProblems } from "./test-account-model-hosts.js";

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
function line(max: number, min = 1) {
  return z.string().min(min).max(max).regex(NO_HIDDEN, "one plain line");
}

export const TEST_ACCOUNT_KINDS = ["api_key", "oauth_client", "basic", "aws_role", "preprod_endpoint"] as const;
export const TEST_ACCOUNT_STATUSES = ["pending", "active", "suspended", "expired", "deleting"] as const;
export const TEST_ACCOUNT_APPROVAL_KINDS = ["approver", "sole_owner_exception"] as const;
export const TEST_ACCOUNT_LIMITS = { hosts: 8, envNames: 4, projects: 50, actions: 20, resources: 20, approvals: 10 } as const;
/** Connections (tunnels the proxy opened) per run, per day and rounds at once (11.2): the defaults and the Rovara maximums. The per-day figure is set by the company, so its maximum is only a sanity bound. */
export const TEST_ACCOUNT_LIMIT_DEFAULTS = { maxConnectionsPerRun: 2_000, maxConnectionsPerDay: 20_000, maxConcurrentRounds: 2 } as const;
export const TEST_ACCOUNT_LIMIT_MAXIMUMS = { maxConnectionsPerRun: 20_000, maxConnectionsPerDay: 1_000_000, maxConcurrentRounds: 10 } as const;
/** An account expires at most 90 days after its last qualifying approval (owner decision Q7); a company setting may only make that shorter, never longer. A reminder goes out 14 days before. */
export const TEST_ACCOUNT_EXPIRY_DAYS = { default: 90, max: 90, reminder: 14 } as const;

// ---- the secret: its name, tags and reference (6.2)

/** The tags every test-account secret carries; the role that reads them is allowed only its own org's path (`rovara:org`). */
export const TEST_ACCOUNT_SECRET_TAG_KEYS = { org: "rovara:org", use: "rovara:use" } as const;
export const TEST_ACCOUNT_SECRET_USE = "test-account";
/** The only version of a test account's secret a worker reads: the one the broker promoted. The reader names it in the request (an omitted stage is not assumed to match the resolve session policy's condition). */
export const TEST_ACCOUNT_SECRET_VERSION_STAGE = "AWSCURRENT";
/** The version a new value waits under until the row that records it is committed (rotation); it never serves a read. */
export const TEST_ACCOUNT_SECRET_PENDING_STAGE = "AWSPENDING";
/** The path segment between the install's environment and the org: test-account secrets live apart from connector and hook secrets, so the connector role cannot reach them. */
export const TEST_ACCOUNT_SECRET_SEGMENT = "org-test-accounts";

const ENV_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u;
const KEY_SEGMENT = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

function assertParts(env: string, orgId: string, accountId: string): void {
  // Fixed message: the values are not echoed, so a wrong one cannot leak into a log.
  if (!ENV_SEGMENT.test(env) || !OrgIdSchema.safeParse(orgId).success || !TestAccountIdSchema.safeParse(accountId).success) throw new RangeError("a test-account secret name needs a valid environment, org and account id");
}

/** `agentx/<env>/org-test-accounts/<orgId>/<accountId>`: where one account's secret lives. Throws on any part that is not a plain segment, so a name can never climb out of its org's path. */
export function testAccountSecretName(env: string, orgId: string, accountId: string): string {
  assertParts(env, orgId, accountId);
  return `agentx/${env}/${TEST_ACCOUNT_SECRET_SEGMENT}/${orgId}/${accountId}`;
}

/** The path an org-tagged role's policy covers: all of one org's test-account secrets and nothing else (ends with a slash). */
export function testAccountSecretPrefix(env: string, orgId: string): string {
  assertParts(env, orgId, "placeholder");
  return `agentx/${env}/${TEST_ACCOUNT_SECRET_SEGMENT}/${orgId}/`;
}

/** The tags a test-account secret is created with. */
export function testAccountSecretTags(orgId: string): Record<string, string> {
  assertParts("env", orgId, "placeholder");
  return { [TEST_ACCOUNT_SECRET_TAG_KEYS.org]: orgId, [TEST_ACCOUNT_SECRET_TAG_KEYS.use]: TEST_ACCOUNT_SECRET_USE };
}

/** `{{resolve:secretsmanager:<name>:SecretString:<key>}}`: the reference an account holds in place of a value. `key` is the JSON key inside the secret. */
export function testAccountSecretRef(env: string, orgId: string, accountId: string, key: string): string {
  if (!KEY_SEGMENT.test(key)) throw new RangeError("a test-account secret key is a plain name");
  return `{{resolve:secretsmanager:${testAccountSecretName(env, orgId, accountId)}:SecretString:${key}}}`;
}

export interface TestAccountSecretRefParts { env: string; orgId: string; accountId: string; key: string }

/** The parts of a reference, or undefined when the text is not exactly one test-account reference (another path, another service, extra segments and traversal are all not). */
export function parseTestAccountSecretRef(ref: string): TestAccountSecretRefParts | undefined {
  const match = /^\{\{resolve:secretsmanager:agentx\/([^/:{}]+)\/org-test-accounts\/([^/:{}]+)\/([^/:{}]+):SecretString:([^/:{}]+)\}\}$/u.exec(ref);
  if (match === null) return undefined;
  const [, env, orgId, accountId, key] = match as unknown as [string, string, string, string, string];
  if (!ENV_SEGMENT.test(env) || !OrgIdSchema.safeParse(orgId).success || !TestAccountIdSchema.safeParse(accountId).success || !KEY_SEGMENT.test(key)) return undefined;
  return { env, orgId, accountId, key };
}

// ---- the key-shape table (6.3): refuse values that look live or production

export type KeyShapeCode = "empty" | "too_long" | "not_one_line" | "private_key_block" | "long_lived_aws_key" | "live_shaped" | "not_test_shaped";
export type KeyShapeVerdict = { ok: true } | { ok: false; code: KeyShapeCode };

interface VendorKeyRule {
  /** The families (their host) this rule applies to. */
  hosts: readonly RegExp[];
  /** A value matching any of these is the vendor's live shape. */
  live: readonly RegExp[];
  /** Where the vendor has a test shape, the value must match one of these. */
  test: readonly RegExp[];
}

/** Per-vendor rules. Small on purpose: it grows with use, each row with its own test. Live is checked before test, so a value cannot match both. */
export const TEST_ACCOUNT_VENDOR_KEY_RULES: readonly VendorKeyRule[] = [
  // A payment provider whose keys carry the mode in their prefix: live keys refused, only test keys accepted.
  { hosts: [/^api\.stripe\.com$/u], live: [/(?:^|[^A-Za-z0-9])(?:sk|rk|pk)_live_/u], test: [/^(?:sk|rk|pk)_test_[A-Za-z0-9]{8,}$/u] },
];

// A word that says the value is live: delimited by anything that is not a letter or digit.
const LIVE_WORD = /(?:^|[^A-Za-z0-9])(?:live|prod|production|prd)(?:[^A-Za-z0-9]|$)/iu;
const VALUE_MAX = 4_096;

function hostOfFamily(family: string): string | undefined {
  return family.startsWith("http:") ? family.slice(5) : undefined;
}

/**
 * Whether a value that is about to be saved as a test account's secret looks acceptable: the verdict is a fixed code, never the value. Checked at save, per vendor family, failing closed:
 * private keys, long-lived AWS keys and anything live-shaped are refused, and where the vendor has a test shape only that shape passes. A family with no row is checked by the generic rules only.
 */
export function checkTestAccountKeyShape(family: string, value: string): KeyShapeVerdict {
  if (value.length === 0) return { ok: false, code: "empty" };
  if (value.length > VALUE_MAX) return { ok: false, code: "too_long" };
  if (value.includes("-----BEGIN")) return { ok: false, code: "private_key_block" };
  if (/[\p{Cc}\p{Cf}]/u.test(value)) return { ok: false, code: "not_one_line" };
  if (AWS_KEY_ID.test(value)) return { ok: false, code: "long_lived_aws_key" };
  const host = hostOfFamily(family);
  const rules = host === undefined ? [] : TEST_ACCOUNT_VENDOR_KEY_RULES.filter((rule) => rule.hosts.some((pattern) => pattern.test(host)));
  if (rules.some((rule) => rule.live.some((pattern) => pattern.test(value)))) return { ok: false, code: "live_shaped" };
  if (LIVE_WORD.test(value)) return { ok: false, code: "live_shaped" };
  if (rules.some((rule) => rule.test.length > 0 && !rule.test.some((pattern) => pattern.test(value)))) return { ok: false, code: "not_test_shaped" };
  return { ok: true };
}

// ---- hosts (4.3, 6.3)

interface SandboxHostRule {
  /** Every host of the vendor. */
  domain: RegExp;
  /** The vendor's sandbox hosts: any other host of the vendor is production. */
  sandbox: readonly RegExp[];
}

/** Vendors that keep production and sandbox on different hosts: only the sandbox ones may be a test account's. */
export const TEST_ACCOUNT_SANDBOX_HOST_RULES: readonly SandboxHostRule[] = [
  // A CRM: production logins and org hosts are refused; only its test login and sandbox org hosts pass.
  { domain: /(?:^|\.)salesforce\.com$/u, sandbox: [/^test\.salesforce\.com$/u, /\.sandbox\.my\.salesforce\.com$/u, /\.scratch\.my\.salesforce\.com$/u] },
  // A payments platform: live and sandbox API hosts differ by a label.
  { domain: /(?:^|\.)paypal\.com$/u, sandbox: [/(?:^|\.)sandbox\.paypal\.com$/u] },
  // A banking-data API: sandbox host only.
  { domain: /(?:^|\.)plaid\.com$/u, sandbox: [/^sandbox\.plaid\.com$/u] },
];

/** A label that says the host is live, anywhere in the name. */
const PROD_LABEL = /(?:^|\.)(?:prod|production|prd|live)(?:\.|$)/u;

export type TestAccountHostCode = "vendor_production_host" | "prod_shaped_host";

/** The hosts (by position) that look like production: a vendor's production host where the vendor has a sandbox, or a name with a prod/live label. Codes and positions only. */
export function testAccountHostProblems(hosts: readonly string[]): Array<{ index: number; code: TestAccountHostCode }> {
  const found: Array<{ index: number; code: TestAccountHostCode }> = [];
  hosts.forEach((raw, index) => {
    const host = normalizeDenyHost(raw) ?? "";
    if (TEST_ACCOUNT_SANDBOX_HOST_RULES.some((rule) => rule.domain.test(host) && !rule.sandbox.some((pattern) => pattern.test(host)))) found.push({ index, code: "vendor_production_host" });
    else if (PROD_LABEL.test(host)) found.push({ index, code: "prod_shaped_host" });
  });
  return found;
}

// ---- AWS: what a role account may do, and where it may go (4.3)

/**
 * The only actions a test account's session policy may hold, by service: data-plane calls on the services Rovara local AWS stands in for. Everything not listed is refused (fail closed), and
 * with it everything that grants or changes access (`*Policy`, `*Permission`, `Grant`, `Acl`), secrets, parameters and keys (secretsmanager, ssm, kms), code changes (lambda `Update*`,
 * `AddPermission`) and instance access (ec2-instance-connect). A service gets in by being added here, in a reviewed change.
 */
export const TEST_ACCOUNT_AWS_ACTIONS = {
  s3: ["GetObject", "PutObject", "DeleteObject", "ListBucket"],
  dynamodb: ["GetItem", "PutItem", "UpdateItem", "DeleteItem", "Query", "Scan", "BatchGetItem", "BatchWriteItem"],
  sqs: ["SendMessage", "ReceiveMessage", "DeleteMessage", "GetQueueAttributes", "GetQueueUrl"],
  sns: ["Publish"],
  kinesis: ["PutRecord", "PutRecords", "GetRecords", "GetShardIterator"],
  events: ["PutEvents"],
  sagemaker: ["InvokeEndpoint"],
} as const satisfies Record<string, readonly string[]>;
type AwsActionService = keyof typeof TEST_ACCOUNT_AWS_ACTIONS;

/** The regional endpoint name under `<prefix>.<region>.amazonaws.com` for each service of the list. */
const AWS_ENDPOINT_PREFIX: Record<AwsActionService, string> = { s3: "s3", dynamodb: "dynamodb", sqs: "sqs", sns: "sns", kinesis: "kinesis", events: "events", sagemaker: "runtime.sagemaker" };

const awsActionAllowed = (action: string): boolean => {
  const [service, name] = action.split(":");
  const allowed = service === undefined ? undefined : (TEST_ACCOUNT_AWS_ACTIONS as Record<string, readonly string[] | undefined>)[service];
  return allowed !== undefined && name !== undefined && allowed.includes(name);
};
const awsServiceOfAction = (action: string): AwsActionService => action.slice(0, action.indexOf(":")) as AwsActionService;

/** An S3 bucket name: lower case letters, digits, dots and hyphens; 3 to 63 characters. Never a wildcard. */
const S3_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
/** Spellings S3 itself refuses for a bucket: an IPv4-shaped name, a name with `..`, `.-` or `-.`, and the reserved `xn--` prefix. */
const S3_BUCKET_REFUSED = /^\d{1,3}(?:\.\d{1,3}){3}$|\.\.|\.-|-\.|^xn--/u;

const RoleArn = z.string().max(256).regex(/^arn:aws(?:-[a-z]+)*:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,200}$/u, "an IAM role ARN");
/** An ARN in the plain, bounded form: six colon-separated fields, no `?`, and `*` only in the last field (the next check says where). */
const Arn = z.string().max(512).regex(/^arn:[a-z-]+:[a-z0-9-]+:[a-z0-9-]*:\d*:[A-Za-z0-9+=,.@_/*-]{1,400}$/u, "an ARN");
/** An explicit action, `service:Action`, from the allow-list above: no wildcard, nothing else. */
const IamAction = z.string().max(128).regex(/^[a-z0-9-]+:[A-Za-z0-9]+$/u, "an explicit IAM action");

const arnField = (arn: string, index: number): string | undefined => {
  const value = arn.split(":")[index];
  return value === undefined || value === "" ? undefined : value;
};

export type AwsResourceProblem = "fields" | "partition" | "service" | "region" | "account" | "wildcard" | "bucket";

/**
 * Why a resource ARN is not acceptable for this role and region, or undefined when it is. The partition, region and account must be the role's own, and the service one of the approved actions' services.
 * A resource names what it covers: `*` and `?` are allowed nowhere except a single trailing `/*` after a named resource (`bucket/*`, `table/orders/index/*`), never after only a type (`table/*`). An S3 ARN has
 * no region or account and names a bucket that is not a wildcard.
 */
export function awsResourceProblem(resource: string, role: { partition: string; account: string; region: string }, services: ReadonlySet<string>): AwsResourceProblem | undefined {
  const parts = resource.split(":");
  if (parts.length !== 6 || parts[0] !== "arn" || /[?]/u.test(resource)) return "fields";
  const [, partition, service, region, account, path] = parts as [string, string, string, string, string, string];
  if (partition !== role.partition) return "partition";
  if (!services.has(service)) return "service";
  if (path === "" || path.includes("//") || path.startsWith("/")) return "wildcard";
  const stars = path.split("*").length - 1;
  const trailing = stars === 1 && path.endsWith("/*") ? path.slice(0, -2) : undefined;
  if (stars > 0 && (trailing === undefined || trailing === "")) return "wildcard";
  const named = trailing ?? path;
  if (service === "s3") {
    if (region !== "" || account !== "") return "region";
    const bucket = named.split("/")[0] ?? "";
    return S3_BUCKET.test(bucket) && !S3_BUCKET_REFUSED.test(bucket) ? undefined : "bucket";
  }
  if (region !== role.region) return "region";
  if (account !== role.account) return "account";
  // After a trailing /*, what is covered must still be named: more than a type (`table/orders`, not `table`).
  if (trailing !== undefined && !/^[^/]+\/[^/]+(?:\/[^/]+)*$/u.test(trailing)) return "wildcard";
  return undefined;
}

/** The regional endpoints a role account may reach: one for each approved action's service, in the account's region, with no extra label. */
export function testAccountAwsEndpointHosts(aws: Pick<TestAccountAws, "actions" | "region">): string[] {
  const services = [...new Set(aws.actions.map(awsServiceOfAction))].filter((service) => service in AWS_ENDPOINT_PREFIX);
  return services.map((service) => `${AWS_ENDPOINT_PREFIX[service]}.${aws.region}.amazonaws.com`);
}

/**
 * The external id of an AWS role account: `rovara-<orgId>-<accountId>`. Rovara builds it from the org the request is for and the account's own id; a customer never chooses it, so one company's account
 * can never cause an AssumeRole that carries another company's id (cloudwatchExternalId's pattern, with the account). `org_...` makes it match the `rovara-org_*` condition the broker's grant carries.
 */
export const testAccountExternalId = (orgId: string, accountId: string): string => `rovara-${orgId}-${accountId}`;

export const TestAccountAwsSchema = z
  .object({
    roleArn: RoleArn,
    /** The external id of the customer's trust policy (a confused-deputy guard, not a secret). Rovara derives it (`testAccountExternalId`), the customer puts it in the trust policy, and the account record must carry exactly that value. */
    externalId: z.string().regex(/^[A-Za-z0-9_+=,.@:/-]{8,128}$/u, "an external id"),
    region: TestEnvRegionSchema,
    actions: z.array(IamAction).min(1).max(TEST_ACCOUNT_LIMITS.actions),
    resources: z.array(Arn).min(1).max(TEST_ACCOUNT_LIMITS.resources),
  })
  .strict()
  .superRefine((aws, context) => {
    const problem = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
    if (new Set(aws.actions).size !== aws.actions.length) problem(["actions"], "an action is listed once");
    if (new Set(aws.resources).size !== aws.resources.length) problem(["resources"], "a resource is listed once");
    aws.actions.forEach((action, index) => {
      if (!awsActionAllowed(action)) problem(["actions", index], "only the data-plane actions Rovara lists are allowed");
    });
    const role = { partition: arnField(aws.roleArn, 1) ?? "", account: arnField(aws.roleArn, 4) ?? "", region: aws.region };
    const services = new Set(aws.actions.filter(awsActionAllowed).map(awsServiceOfAction));
    aws.resources.forEach((resource, index) => {
      const found = awsResourceProblem(resource, role, services);
      if (found !== undefined) problem(["resources", index], "a resource names what it covers, in the role's own partition, region and account, for an approved service");
    });
  });
export type TestAccountAws = z.infer<typeof TestAccountAwsSchema>;

// ---- the record

const SecretRefSchema = z.string().max(400).refine((ref) => parseTestAccountSecretRef(ref) !== undefined, "a test-account secret reference");

const DeveloperId = z.string().regex(/^[a-f0-9]{64}$/u);
/**
 * One person's approval of one exact record: `approvedDigest` is `testAccountApprovalDigest` of what they were shown (the account's id and org, kind, family, hosts, AWS block, variables, projects, limits, secret reference). An approval
 * whose digest is not the record's current one approved something else and counts for nothing, so widening a record needs fresh approvals.
 */
export const TestAccountApprovalSchema = z
  .object({ by: DeveloperId, at: z.string().datetime(), freshSignIn: z.literal(true), kind: z.enum(TEST_ACCOUNT_APPROVAL_KINDS), approvedDigest: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();
export type TestAccountApproval = z.infer<typeof TestAccountApprovalSchema>;

/** The fields an approval covers. */
export interface TestAccountApprovable {
  /** The account's own id and its org: an approval of these fields under another id or org approves another account, even for a role-only AWS account that has no secret reference to tell them apart. */
  id: string;
  orgId: string;
  kind: string;
  family: string;
  hosts: readonly string[];
  aws?: { roleArn: string; externalId: string; region: string; actions: readonly string[]; resources: readonly string[] } | undefined;
  envNames: readonly string[];
  projectIds: "all" | readonly string[];
  limits: { maxConnectionsPerRun: number; maxConnectionsPerDay: number; maxConcurrentRounds: number };
  secretRef?: string | undefined;
}

const sorted = (values: readonly string[]): string[] => [...values].sort();

/** The digest an approval is bound to: canonical JSON of what the approvers were shown, with lists in a fixed order so a re-ordered list is the same record. */
export function testAccountApprovalDigest(record: TestAccountApprovable): string {
  return sha256Hex(
    canonicalJson({
      id: record.id,
      orgId: record.orgId,
      kind: record.kind,
      family: record.family,
      hosts: sorted(record.hosts),
      aws: record.aws === undefined ? null : { ...record.aws, actions: sorted(record.aws.actions), resources: sorted(record.aws.resources) },
      envNames: sorted(record.envNames),
      projectIds: record.projectIds === "all" ? "all" : sorted(record.projectIds),
      limits: record.limits,
      secretRef: record.secretRef ?? null,
    }),
  );
}

// ---- the run-time secret grant (6.2, 4.3): what the broker hands the worker for ONE sealed round

/** How long a grant's session lasts: Secrets Manager's own minimum for an assumed session (15 minutes), enough for the start of one test command. */
export const TEST_ACCOUNT_GRANT_SECONDS = 900;

const GrantCredentialPart = z.string().min(1).max(4_096).regex(/^[\x21-\x7e]+$/u, "one token");

/**
 * What the broker sends the worker so the worker can read ONE test-account secret at run time: a session the broker minted for that one secret and the read of it (15 minutes), the secret's name and the
 * JSON key inside it, and the variables the test reads it from. It holds session credentials, so it is never logged, journaled or put in a plan; it travels only in the invocation of a sealed round.
 * The secret's value is not in it, and the broker never has the value.
 */
export const TestAccountSecretGrantSchema = z
  .object({
    orgId: OrgIdSchema,
    accountId: TestAccountIdSchema,
    family: FamilyIdSchema,
    secretName: z.string().max(300),
    key: z.string().regex(KEY_SEGMENT),
    region: TestEnvRegionSchema,
    envNames: z.array(EnvNameSchema).min(1).max(TEST_ACCOUNT_LIMITS.envNames),
    credentials: z.object({ accessKeyId: GrantCredentialPart, secretAccessKey: GrantCredentialPart, sessionToken: GrantCredentialPart }).strict(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .superRefine((grant, context) => {
    const parts = parseTestAccountSecretRef(`{{resolve:secretsmanager:${grant.secretName}:SecretString:${grant.key}}}`);
    if (parts === undefined || parts.orgId !== grant.orgId || parts.accountId !== grant.accountId) context.addIssue({ code: "custom", path: ["secretName"], message: "the grant names this account's own secret in its own org" });
    if (new Set(grant.envNames).size !== grant.envNames.length) context.addIssue({ code: "custom", path: ["envNames"], message: "a variable is listed once" });
    grant.envNames.forEach((name, index) => {
      if (reservedDependencyEnvName(name)) context.addIssue({ code: "custom", path: ["envNames", index], message: "this variable is set by Rovara or the system" });
    });
  });
export type TestAccountSecretGrant = z.infer<typeof TestAccountSecretGrantSchema>;

/** The grant, or undefined. Never throws and never returns the reasons, so a credential in a malformed grant cannot reach a log through its parse error. */
export function parseTestAccountSecretGrant(input: unknown): TestAccountSecretGrant | undefined {
  const result = TestAccountSecretGrantSchema.safeParse(input);
  return result.success ? result.data : undefined;
}

// ---- narrowing (DC-TS-2, design 6.4): which changes need fresh approvals

const subsetOf = (smaller: readonly string[], larger: readonly string[]): boolean => smaller.every((value) => larger.includes(value));

/**
 * Whether `resource` is covered by `previous`: the same ARN, or an ARN under a named prefix that ends in `/*` (`bucket/*` covers `bucket/reports/*` and `bucket/a.csv`, but not `bucket` itself, another bucket
 * with the same start, or a resource with a wildcard anywhere but a single trailing `/*`). Anything else is not provably smaller.
 */
function resourceCovered(previous: readonly string[], resource: string): boolean {
  if (previous.includes(resource)) return true;
  if (/[?]|\/\//u.test(resource)) return false;
  const named = resource.endsWith("/*") ? resource.slice(0, -2) : resource;
  if (named.includes("*")) return false;
  return previous.some((each) => {
    if (!each.endsWith("/*") || each.slice(0, -2).includes("*")) return false;
    const prefix = each.slice(0, -1);
    return resource.startsWith(prefix) && resource.length > prefix.length;
  });
}

/**
 * Whether going from `previous` to `next` is a widening. Only a change this function can PROVE is smaller is not one, and it must be smaller in every field at once: the same account, kind, family, secret
 * reference and AWS role, no host, variable, action or resource that was not there, no project the account was not already open to, and no higher limit. Everything else (including a different credential
 * and any change it cannot compare) is a widening. A pure narrowing applies at once and re-stamps the approvals with the new digest (`restampApprovals`); a widening needs fresh approvals. The label, status,
 * approvals and dates are not part of an approval, so they are not compared.
 */
export function testAccountWidened(previous: TestAccountApprovable, next: TestAccountApprovable): boolean {
  if (previous.id !== next.id || previous.orgId !== next.orgId || previous.kind !== next.kind || previous.family !== next.family) return true;
  if ((previous.secretRef ?? null) !== (next.secretRef ?? null)) return true;
  if (!subsetOf(next.hosts, previous.hosts) || !subsetOf(next.envNames, previous.envNames)) return true;
  if (previous.projectIds !== "all" && (next.projectIds === "all" || !subsetOf(next.projectIds, previous.projectIds))) return true;
  const was = previous.limits;
  const now = next.limits;
  if (now.maxConnectionsPerRun > was.maxConnectionsPerRun || now.maxConnectionsPerDay > was.maxConnectionsPerDay || now.maxConcurrentRounds > was.maxConcurrentRounds) return true;
  if ((previous.aws === undefined) !== (next.aws === undefined)) return true;
  if (previous.aws !== undefined && next.aws !== undefined) {
    if (previous.aws.roleArn !== next.aws.roleArn || previous.aws.externalId !== next.aws.externalId || previous.aws.region !== next.aws.region) return true;
    if (!subsetOf(next.aws.actions, previous.aws.actions)) return true;
    if (!next.aws.resources.every((resource) => resourceCovered(previous.aws!.resources, resource))) return true;
  }
  return false;
}

/** Re-stamps the approvals that approved `previous` so they approve `next`, for a change `testAccountWidened` says is not a widening. Approvals of anything else are dropped. Throws on a widening. */
export function restampApprovals(previous: TestAccountApprovable & { approvals: readonly TestAccountApproval[] }, next: TestAccountApprovable): TestAccountApproval[] {
  if (testAccountWidened(previous, next)) throw new RangeError("only a narrowing is re-stamped");
  const digest = testAccountApprovalDigest(next);
  return testAccountQualifyingApprovals(previous).map((approval) => ({ ...approval, approvedDigest: digest }));
}

/**
 * The approvals that approved exactly this record. With `now`, an approval dated after it does not count (a future date is no approval yet, and a date that is not a date never counts), so nothing
 * that is computed from approvals (the people, the expiry window) can lean on one that has not happened.
 */
export function testAccountQualifyingApprovals(record: TestAccountApprovable & { approvals: readonly TestAccountApproval[] }, now?: number): TestAccountApproval[] {
  const digest = testAccountApprovalDigest(record);
  return record.approvals.filter((approval) => approval.approvedDigest === digest && (now === undefined || Date.parse(approval.at) <= now));
}

/** Whether the approvals are enough for an account to be active: two different people, each with a fresh sign-in, or the sole-owner exception (company switch and eligibility are the approver's, checked where it is recorded). Only qualifying approvals are passed in. */
export function testAccountApprovalsSatisfied(qualifying: readonly TestAccountApproval[]): boolean {
  return new Set(qualifying.map((approval) => approval.by)).size >= 2 || qualifying.some((approval) => approval.kind === "sole_owner_exception");
}

const DAY_MS = 86_400_000;
const latestAt = (approvals: readonly TestAccountApproval[]): number => Math.max(0, ...approvals.map((approval) => Date.parse(approval.at)));

/**
 * A test account's host: the shared host rule, and never an AI model service (FIX-0518). The model check runs first and on the raw text, so a case variant or a trailing dot gets the model sentence, not the generic
 * "lower-case host name" one. The sentence never repeats the host.
 */
const TestAccountHostSchema = z.string().superRefine((host, context) => {
  if (isTestAccountModelHost(host)) {
    context.addIssue({ code: "custom", message: TEST_ACCOUNT_MODEL_HOST_SENTENCE });
    return;
  }
  const shared = TestServiceHostSchema.safeParse(host);
  if (!shared.success) for (const issue of shared.error.issues) context.addIssue({ code: "custom", message: issue.message });
});

const TestAccountObjectSchema = z
  .object({
    id: TestAccountIdSchema,
    orgId: OrgIdSchema,
    projectIds: z.union([z.literal("all"), z.array(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u)).min(1).max(TEST_ACCOUNT_LIMITS.projects)]),
    /** `http:<host>` for an outside API, `aws:<service>` for an AWS account. */
    family: FamilyIdSchema,
    label: line(80),
    kind: z.enum(TEST_ACCOUNT_KINDS),
    /** The reference to the secret, never its value. */
    secretRef: SecretRefSchema.optional(),
    aws: TestAccountAwsSchema.optional(),
    /** The proxy's allow-list for this account. */
    hosts: z.array(TestAccountHostSchema).min(1).max(TEST_ACCOUNT_LIMITS.hosts),
    /** The variables the test reads its secret from (`PAYMENTS_API_KEY`). */
    envNames: z.array(EnvNameSchema).max(TEST_ACCOUNT_LIMITS.envNames),
    limits: z
      .object({
        maxConnectionsPerRun: z.number().int().min(1).max(TEST_ACCOUNT_LIMIT_MAXIMUMS.maxConnectionsPerRun),
        maxConnectionsPerDay: z.number().int().min(1).max(TEST_ACCOUNT_LIMIT_MAXIMUMS.maxConnectionsPerDay),
        maxConcurrentRounds: z.number().int().min(1).max(TEST_ACCOUNT_LIMIT_MAXIMUMS.maxConcurrentRounds),
      })
      .strict(),
    approvals: z.array(TestAccountApprovalSchema).max(TEST_ACCOUNT_LIMITS.approvals),
    status: z.enum(TEST_ACCOUNT_STATUSES),
    expiresAt: z.string().datetime().optional(),
    rotatedAt: z.string().datetime().optional(),
    lastUsedAt: z.string().datetime().optional(),
  })
  .strict();
export type TestAccount = z.infer<typeof TestAccountObjectSchema>;

export interface TestAccountSchemaOptions {
  /** The install's environment name: a secret reference must point into it. Without it any environment segment passes (the shape is still checked). */
  env?: string;
  /** A company's shorter expiry, in whole days from 1 to 90. A longer one is refused when the schema is made, never silently capped. */
  maxExpiryDays?: number;
  /** A company's own model gateway hosts (the catalog's company rows): an account for one is refused like any model host. */
  gatewayHosts?: readonly string[];
}

function expiryDaysFor(options: TestAccountSchemaOptions): number {
  const days = options.maxExpiryDays ?? TEST_ACCOUNT_EXPIRY_DAYS.max;
  if (!Number.isInteger(days) || days < 1 || days > TEST_ACCOUNT_EXPIRY_DAYS.max) throw new RangeError("a company may set an expiry of 1 to 90 days, never longer");
  return days;
}

/** The test-account schema for an install (its environment) and a company (its expiry setting). `TestAccountSchema` is the one with neither. */
export function testAccountSchemaFor(options: TestAccountSchemaOptions = {}) {
  const maxDays = expiryDaysFor(options);
  return TestAccountObjectSchema.superRefine((account, context) => {
    const problem = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
    const isAws = account.kind === "aws_role";
    if (isAws !== (account.aws !== undefined)) problem(["aws"], "an AWS role account has the AWS block, and no other account does");
    if (isAws && account.secretRef !== undefined) problem(["secretRef"], "an AWS role account stores no secret");
    if (account.aws !== undefined && account.aws.externalId !== testAccountExternalId(account.orgId, account.id)) problem(["aws", "externalId"], "the external id is the one Rovara derives for this company and account");
    if (isAws && account.envNames.length > 0) problem(["envNames"], "an AWS role account is reached by a role, not a variable");
    if (!isAws && (account.kind === "api_key" || account.kind === "oauth_client" || account.kind === "basic") && account.secretRef === undefined) problem(["secretRef"], "this kind of account needs its secret reference");
    if (!account.family.startsWith("http:") && !account.family.startsWith("aws:")) problem(["family"], "a test account is for an outside API (http:<host>) or an AWS service (aws:<service>)");
    if (!isAws && account.family.startsWith("aws:")) problem(["family"], "only an AWS role account is for an AWS family");
    if (isAws && !account.family.startsWith("aws:")) problem(["family"], "an AWS role account is for an AWS family");
    if (account.family.startsWith("http:") && !account.hosts.includes(account.family.slice(5))) problem(["hosts"], "the account's own host is one of its hosts");
    if (account.family.startsWith("aws:") && account.aws !== undefined && !account.aws.actions.some((action) => action.startsWith(`${account.family.slice(4).replace(/-runtime$/u, "")}:`))) problem(["aws", "actions"], "the account approves an action of its own service");
    if (account.secretRef !== undefined) {
      const parts = parseTestAccountSecretRef(account.secretRef);
      if (parts !== undefined && (parts.orgId !== account.orgId || parts.accountId !== account.id)) problem(["secretRef"], "the reference points at this account's own secret in its own org");
      if (parts !== undefined && options.env !== undefined && parts.env !== options.env) problem(["secretRef"], "the reference points into this install's environment");
    }
    if (new Set(account.hosts).size !== account.hosts.length) problem(["hosts"], "a host is listed once");
    // The company's own gateway hosts (the built-in catalog's are refused by the host schema itself).
    const gatewayHosts = options.gatewayHosts ?? [];
    if (gatewayHosts.length > 0) for (const index of testAccountModelHostProblems(account.hosts, { gatewayHosts })) if (!isTestAccountModelHost(account.hosts[index])) problem(["hosts", index], TEST_ACCOUNT_MODEL_HOST_SENTENCE);
    if (account.aws !== undefined) {
      // Every host is the regional endpoint of a service the account approves, exactly: no bucket subdomain, no API-gateway host, no extra label.
      const endpoints = new Set(testAccountAwsEndpointHosts(account.aws));
      account.hosts.forEach((host, index) => {
        if (!endpoints.has(host)) problem(["hosts", index], "an AWS account reaches only the regional endpoints of the services it approves");
      });
    }
    if (new Set(account.envNames).size !== account.envNames.length) problem(["envNames"], "a variable is listed once");
    account.envNames.forEach((name, index) => {
      if (reservedDependencyEnvName(name)) problem(["envNames", index], "this variable is set by Rovara or the system");
    });
    if (account.projectIds !== "all" && new Set(account.projectIds).size !== account.projectIds.length) problem(["projectIds"], "a project is listed once");
    if (account.limits.maxConnectionsPerRun > account.limits.maxConnectionsPerDay) problem(["limits", "maxConnectionsPerRun"], "a run's requests fit inside the day's");
    if (looksLikeSecretValue(account.label)) problem(["label"], "a label is not the place for a key");
    // Only approvals of exactly this record count; the expiry runs from the last of those.
    const qualifying = testAccountQualifyingApprovals(account);
    if (account.status === "active") {
      if (!testAccountApprovalsSatisfied(qualifying)) problem(["approvals"], "an active account is approved by two people with a fresh sign-in, or by the sole-owner exception, each approving exactly this record");
      if (account.expiresAt === undefined) problem(["expiresAt"], "an active account expires");
    }
    if (account.expiresAt !== undefined && qualifying.length > 0) {
      const expires = Date.parse(account.expiresAt);
      const latest = latestAt(qualifying);
      if (expires <= latest) problem(["expiresAt"], "an account expires after its last approval");
      if (expires - latest > maxDays * DAY_MS) problem(["expiresAt"], `an account expires within ${String(maxDays)} days of its last approval`);
    }
  });
}
export const TestAccountSchema = testAccountSchemaFor();

/**
 * Whether a record may be used at `now`: it is active, its approvals still cover exactly this record, and it has not expired (`now` must be before `expiresAt`). Anything unreadable (a date that is not a date) is not usable.
 * For a record that did not come through the schema, this repeats the checks that matter at run time.
 */
export function isTestAccountUsableAt(record: TestAccount, now: Date | number | string, options: TestAccountSchemaOptions = {}): boolean {
  const at = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(at) || record.status !== "active" || record.expiresAt === undefined) return false;
  const expires = Date.parse(record.expiresAt);
  if (!Number.isFinite(expires) || at >= expires) return false;
  // Only approvals that have happened by `now`: the people and the expiry window both come from those.
  const qualifying = testAccountQualifyingApprovals(record, at);
  if (!testAccountApprovalsSatisfied(qualifying)) return false;
  return expires - latestAt(qualifying) <= expiryDaysFor(options) * DAY_MS;
}

// ---- the production deny list (6.3: at save and at every run)

export type TestAccountProdProblem = { kind: "prod_host" | "prod_arn" | "prod_account" | "prod_deny_missing" | "prod_shaped_host" | "vendor_production_host" | "rovara_account" | "model_host"; field: string };

/**
 * Everything in the account that names production, as fixed codes with the field they were found in: a host on the deny list or one that looks like production, a role or resource on it, an account
 * that is Rovara's own, or `prod_deny_missing` when the company has listed nothing at all (an account reaches a real remote, so the list must exist first). Empty: nothing found. `alsoDeny` is the list
 * the approved environment had, so removing an entry in the same change that points at it hides nothing.
 */
export function testAccountProdProblems(account: TestAccount, deny: TestEnvProdDeny, options: { alsoDeny?: TestEnvProdDeny; rovaraAccountIds?: readonly string[]; modelGatewayHosts?: readonly string[] } = {}): TestAccountProdProblem[] {
  const lists = options.alsoDeny === undefined ? [deny] : [deny, options.alsoDeny];
  // FIX-0518: an account for an AI model service is refused at every use, whatever else is true (the production list may be empty, the record may not have come through today's schema). First, so nothing returns past it.
  const found: TestAccountProdProblem[] = testAccountModelHostProblems(account.hosts, { gatewayHosts: options.modelGatewayHosts ?? [] }).map((index) => ({ kind: "model_host" as const, field: `hosts[${String(index)}]` }));
  if (lists.every((list) => prodDenyIsEmpty(list))) return [...found, { kind: "prod_deny_missing", field: "prodDeny" }];
  account.hosts.forEach((host, index) => {
    if (lists.some((list) => prodDenyMatchesHost(list, host))) found.push({ kind: "prod_host", field: `hosts[${String(index)}]` });
  });
  for (const problem of testAccountHostProblems(account.hosts)) found.push({ kind: problem.code, field: `hosts[${String(problem.index)}]` });
  const arns: Array<{ field: string; arn: string }> = [];
  if (account.aws !== undefined) {
    arns.push({ field: "aws.roleArn", arn: account.aws.roleArn });
    account.aws.resources.forEach((arn, index) => arns.push({ field: `aws.resources[${String(index)}]`, arn }));
  }
  for (const { field, arn } of arns) {
    const kind = lists.map((list) => prodDenyMatchesArn(list, arn)).find((match) => match !== undefined);
    if (kind !== undefined) found.push({ kind, field });
  }
  if (account.aws !== undefined) {
    const own = arnField(account.aws.roleArn, 4);
    if (own !== undefined && (options.rovaraAccountIds ?? []).includes(own)) found.push({ kind: "rovara_account", field: "aws.roleArn" });
  }
  return found;
}
