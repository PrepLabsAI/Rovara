// Real check on the customer's staging, RC1 (design real-check-security-design.md; owner decisions R3-1 to R3-13, 2026-11-18): the CONNECTION contract. A real check makes a few READ-ONLY calls to the customer's own
// staging copy of a dependency. This module is the record that says which staging, as what, how much, and who approved exactly that. It is the contract only: nothing stores, approves, signs or calls yet (the broker,
// RealCheckEgress and the helper are later lanes), and nothing here holds a credential or imports a Node module.
//
// What this module guarantees, so no builder has to remember it:
//   - THREE KINDS, never a stored key file or a long-lived AWS key (R3-1): `gcp_federation` (workload identity federation into a read-only service account: nothing stored), `aws_role_read` (a role with an external
//     id Rovara derives: nothing stored) and `http_secret_ref` (a vendor test key held as a REFERENCE to an org-tagged secret that only RealCheckEgress can read). The record is strict: no member can hold a value;
//   - READ-ONLY, three times (the customer's IAM, the operation tables in `real-check-read-tables.ts`, the classifier in `real-check-classifier.ts`): `mode` can only be `read_only` (R3-4: writes are not built in
//     v1), an AWS role holds only actions of the read table, a GCP connection names the Google APIs it reads, a plain HTTP one may list the operations it approves;
//   - REUSE, not a second copy, of the test-account contract's rules: the secret's name and tags (a new `org-real-checks` segment, so the test-account and connector roles cannot reach it), the live-shaped-key
//     refusal, the host rule and the AI-model-host refusal (FIX-0518), the production host rules and the AWS resource rules, the external id (`rovara-<org>-<connection>`) and the 90-day expiry cap;
//   - ONE approver by default (R3-3, DEC 124): one owner or admin with a fresh sign-in and the "this is not production" tick; a company setting may require a second, and the sole-owner exception applies. An
//     approval carries the digest of exactly what was shown (identity, hosts, the operations the approved APIs allow, caps, projects), so widening a connection needs a fresh approval and a changed table does too;
//   - PRODUCTION is refused by the company's list, which must exist (an empty list refuses everything), by name rules, by AWS account and by GCP project id or number (R3-8);
//   - CAPS (R3-5): 25 calls per check, 200 per project and 1,000 per company a day, 2 at once, 10 s per call, 3 min per check, 1 MiB answers, 1 GB BigQuery; a connection may raise them only up to Rovara's maximums,
//     and `realCheckCapDecision` is the one place a counter is judged;
//   - a RUN GRANT binds one run to one connection, one revision and one approval digest for 15 to 30 minutes (the signature is the broker's and RealCheckEgress's, a later lane);
//   - the LEDGER row has no member that can hold a body, a query value, a header or a token, and every refusal has fixed words.
// Every function returns fixed codes and field names, never the text it checked.
import { z } from "zod";
import { OrgIdSchema } from "./browser-ids.js";
import { canonicalJson } from "./canonical-json.js";
import { TestEnvRegionSchema } from "./test-env-dependency.js";
import { TestServiceHostSchema, hostProblem, looksLikeSecretValue } from "./test-services-shared.js";
import { normalizeDenyHost, prodDenyIsEmpty, prodDenyMatchesArn, prodDenyMatchesHost } from "./test-environment-prod-deny.js";
import { sha256Hex } from "./web-hash.js";
import { TEST_ACCOUNT_MODEL_HOST_SENTENCE, isTestAccountModelHost, testAccountModelHostProblems } from "./test-account-model-hosts.js";
import { TEST_ACCOUNT_EXPIRY_DAYS, TEST_ACCOUNT_SECRET_TAG_KEYS, awsResourceProblem, checkTestAccountKeyShape, testAccountAwsEndpointHosts, testAccountExternalId, testAccountHostProblems, type KeyShapeVerdict } from "./test-account.js";
import {
  REAL_CHECK_GOOGLE_APIS,
  REAL_CHECK_GOOGLE_HOSTS,
  REAL_CHECK_GOOGLE_ROWS,
  REAL_CHECK_LIMIT_KEYS,
  REAL_CHECK_LIMIT_MAXIMUMS,
  REAL_CHECK_METHOD_OVERRIDE_HEADERS,
  isRealCheckAwsReadAction,
  type RealCheckLimits,
} from "./real-check-read-tables.js";
import { isRealCheckOperationTemplate, type RealCheckProdDeny, type RealCheckVerdict } from "./real-check-classifier.js";

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
function line(max: number, min = 1) {
  return z.string().min(min).max(max).regex(NO_HIDDEN, "one plain line");
}

export const REAL_CHECK_KINDS = ["gcp_federation", "aws_role_read", "http_secret_ref"] as const;
export const REAL_CHECK_STATUSES = ["pending", "active", "suspended", "expired", "deleting"] as const;
export const REAL_CHECK_APPROVAL_KINDS = ["approver", "sole_owner_exception"] as const;
export const REAL_CHECK_MODES = ["read_only"] as const;
export const REAL_CHECK_LIMITS = { hosts: 8, projects: 50, operations: 20, graphqlPaths: 4, actions: 20, resources: 20, approvals: 10 } as const;
/** The same 90-day cap and 14-day reminder as a test account (owner decision Q7); a company may set fewer days. */
export const REAL_CHECK_EXPIRY_DAYS = TEST_ACCOUNT_EXPIRY_DAYS;
/** A grant lives 15 to 30 minutes (design 3.1). */
export const REAL_CHECK_GRANT_SECONDS = { min: 900, max: 1_800 } as const;

// ---- names: the connection id, the session name, the external id, the secret

/** A connection's id: short enough that `<orgId>.<connectionId>` fits the 64 characters of an AWS and a Google session name. */
export const RealCheckConnectionIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,38}$/u);
const ENV_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u;
const KEY_SEGMENT = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

function assertParts(env: string, orgId: string, connectionId: string): void {
  // Fixed message: the values are not echoed, so a wrong one cannot leak into a log.
  if (!ENV_SEGMENT.test(env) || !OrgIdSchema.safeParse(orgId).success || !RealCheckConnectionIdSchema.safeParse(connectionId).success) throw new RangeError("a real-check name needs a valid environment, org and connection id");
}

/** `<orgId>.<connectionId>`: the session name for a GCP federation and an AWS assume-role call. The customer's own condition names exactly this, so one connection of one company is granted, not every one. */
export function realCheckSessionName(orgId: string, connectionId: string): string {
  assertParts("env", orgId, connectionId);
  return `${orgId}.${connectionId}`;
}

/** `rovara-<orgId>-<connectionId>`: the AWS external id, derived by Rovara (the test-account rule, with the connection's id). A customer never chooses it. */
export const realCheckExternalId = (orgId: string, connectionId: string): string => testAccountExternalId(orgId, connectionId);

export const REAL_CHECK_SECRET_SEGMENT = "org-real-checks";
export const REAL_CHECK_SECRET_USE = "real-check";

/** `agentx/<env>/org-real-checks/<orgId>/<connectionId>`: where one connection's vendor key lives, apart from test-account, connector and hook secrets. Throws on any part that is not a plain segment. */
export function realCheckSecretName(env: string, orgId: string, connectionId: string): string {
  assertParts(env, orgId, connectionId);
  return `agentx/${env}/${REAL_CHECK_SECRET_SEGMENT}/${orgId}/${connectionId}`;
}

/** The path an org-tagged role's policy covers: all of one org's real-check secrets and nothing else (ends with a slash). */
export function realCheckSecretPrefix(env: string, orgId: string): string {
  assertParts(env, orgId, "placeholder");
  return `agentx/${env}/${REAL_CHECK_SECRET_SEGMENT}/${orgId}/`;
}

/** The tags a real-check secret is created with: the org (what the reading role's policy compares) and the use. */
export function realCheckSecretTags(orgId: string): Record<string, string> {
  assertParts("env", orgId, "placeholder");
  return { [TEST_ACCOUNT_SECRET_TAG_KEYS.org]: orgId, [TEST_ACCOUNT_SECRET_TAG_KEYS.use]: REAL_CHECK_SECRET_USE };
}

/** `{{resolve:secretsmanager:<name>:SecretString:<key>}}`: the reference a connection holds in place of a value. */
export function realCheckSecretRef(env: string, orgId: string, connectionId: string, key: string): string {
  if (!KEY_SEGMENT.test(key)) throw new RangeError("a real-check secret key is a plain name");
  return `{{resolve:secretsmanager:${realCheckSecretName(env, orgId, connectionId)}:SecretString:${key}}}`;
}

export interface RealCheckSecretRefParts {
  env: string;
  orgId: string;
  connectionId: string;
  key: string;
}

/** The parts of a reference, or undefined when the text is not exactly one real-check reference (a test-account or connector reference, another path, extra segments and traversal are all not). */
export function parseRealCheckSecretRef(ref: string): RealCheckSecretRefParts | undefined {
  const match = /^\{\{resolve:secretsmanager:agentx\/([^/:{}]+)\/org-real-checks\/([^/:{}]+)\/([^/:{}]+):SecretString:([^/:{}]+)\}\}$/u.exec(ref);
  if (match === null) return undefined;
  const [, env, orgId, connectionId, key] = match as unknown as [string, string, string, string, string];
  if (!ENV_SEGMENT.test(env) || !OrgIdSchema.safeParse(orgId).success || !RealCheckConnectionIdSchema.safeParse(connectionId).success || !KEY_SEGMENT.test(key)) return undefined;
  return { env, orgId, connectionId, key };
}

/** Whether a vendor key about to be saved looks acceptable for this host: the test-account rule (a live-shaped key, a private key, a long-lived AWS key are refused; a vendor with a test shape accepts only it). A fixed code, never the value. */
export function checkRealCheckKeyShape(host: string, value: string): KeyShapeVerdict {
  return checkTestAccountKeyShape(`http:${host}`, value);
}

// ---- the three identity blocks

const GCP_PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const GCP_SERVICE_ACCOUNT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/u;
const GCP_POOL_AUDIENCE = /^\/\/iam\.googleapis\.com\/projects\/[1-9][0-9]{5,14}\/locations\/global\/workloadIdentityPools\/[a-z][a-z0-9-]{2,30}[a-z0-9]\/providers\/[a-z][a-z0-9-]{2,30}[a-z0-9]$/u;

/**
 * GCP: workload identity federation into a read-only service account in the customer's staging project. Nothing is stored: the pool audience, the account's address and the project are names. The session name the
 * customer's pool condition must match is `realCheckSessionName(orgId, connectionId)`.
 */
export const RealCheckGcpSchema = z
  .object({
    projectId: z.string().regex(GCP_PROJECT_ID, "a Google Cloud project id"),
    projectNumber: z.string().regex(/^[1-9][0-9]{5,14}$/u, "a Google Cloud project number").optional(),
    poolAudience: z.string().max(300).regex(GCP_POOL_AUDIENCE, "a workload identity provider audience"),
    serviceAccount: z.string().max(120).regex(GCP_SERVICE_ACCOUNT, "a service account address"),
    /** The Google APIs this connection reads. Its hosts are exactly theirs. */
    apis: z.array(z.enum(REAL_CHECK_GOOGLE_APIS)).min(1).max(REAL_CHECK_GOOGLE_APIS.length),
  })
  .strict()
  .superRefine((gcp, context) => {
    const problem = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
    if (GCP_SERVICE_ACCOUNT.exec(gcp.serviceAccount)?.[1] !== gcp.projectId) problem(["serviceAccount"], "the service account lives in the staging project");
    if (new Set(gcp.apis).size !== gcp.apis.length) problem(["apis"], "an API is listed once");
  });
export type RealCheckGcp = z.infer<typeof RealCheckGcpSchema>;

const RoleArn = z.string().max(256).regex(/^arn:aws(?:-[a-z]+)*:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,200}$/u, "an IAM role ARN");
const Arn = z.string().max(512).regex(/^arn:[a-z-]+:[a-z0-9-]+:[a-z0-9-]*:\d*:[A-Za-z0-9+=,.@_/*-]{1,400}$/u, "an ARN");
const IamAction = z.string().max(128).regex(/^[a-z0-9-]+:[A-Za-z0-9]+$/u, "an explicit IAM action");
const arnField = (arn: string, index: number): string | undefined => {
  const value = arn.split(":")[index];
  return value === undefined || value === "" ? undefined : value;
};

/** AWS: a role in the customer's staging account with READ actions only (the table in `real-check-read-tables.ts`), assumed with the external id Rovara derives. Nothing is stored. */
export const RealCheckAwsReadSchema = z
  .object({
    roleArn: RoleArn,
    externalId: z.string().regex(/^[A-Za-z0-9_+=,.@:/-]{8,128}$/u, "an external id"),
    region: TestEnvRegionSchema,
    actions: z.array(IamAction).min(1).max(REAL_CHECK_LIMITS.actions),
    resources: z.array(Arn).min(1).max(REAL_CHECK_LIMITS.resources),
  })
  .strict()
  .superRefine((aws, context) => {
    const problem = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
    if (new Set(aws.actions).size !== aws.actions.length) problem(["actions"], "an action is listed once");
    if (new Set(aws.resources).size !== aws.resources.length) problem(["resources"], "a resource is listed once");
    aws.actions.forEach((action, index) => {
      if (!isRealCheckAwsReadAction(action)) problem(["actions", index], "only the read actions Rovara lists are allowed");
    });
    const role = { partition: arnField(aws.roleArn, 1) ?? "", account: arnField(aws.roleArn, 4) ?? "", region: aws.region };
    const services = new Set(aws.actions.filter(isRealCheckAwsReadAction).map((action) => action.slice(0, action.indexOf(":"))));
    aws.resources.forEach((resource, index) => {
      if (awsResourceProblem(resource, role, services) !== undefined) problem(["resources", index], "a resource names what it covers, in the role's own partition, region and account, for an approved service");
    });
  });
export type RealCheckAwsRead = z.infer<typeof RealCheckAwsReadSchema>;

const SecretRefSchema = z.string().max(400).refine((ref) => parseRealCheckSecretRef(ref) !== undefined, "a real-check secret reference");

/** Header names a vendor key may not be placed in: framing, connection and cookie headers, and the headers that change a request's method. */
const FORBIDDEN_HEADER_NAMES = new Set(["host", "content-length", "content-type", "transfer-encoding", "connection", "upgrade", "te", "trailer", "cookie", "set-cookie", "proxy-authorization", "proxy-authenticate", ...REAL_CHECK_METHOD_OVERRIDE_HEADERS]);
const HeaderName = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/u, "a header name").refine((name) => !FORBIDDEN_HEADER_NAMES.has(name.toLowerCase()), "a header a key may be placed in");

const PlacementSchema = z.discriminatedUnion("scheme", [
  z.object({ scheme: z.literal("bearer") }).strict(),
  z.object({ scheme: z.literal("header"), name: HeaderName }).strict(),
  /** An OAuth client-credentials exchange RealCheckEgress does itself; the token host is added internally and is not a staging host. */
  z.object({ scheme: z.literal("oauth_client_credentials"), tokenHost: z.string() }).strict(),
]);

const GraphqlPath = z.string().max(100).regex(/^\/[A-Za-z0-9/_-]{0,99}$/u, "a path").refine((path) => !path.endsWith("/") && !path.includes("//"), "no trailing slash or empty segment");

/** A vendor's test key: held as a reference only RealCheckEgress can resolve, and placed by a fixed scheme. The operations (`GET /v2/user/videos/{id}`) and GraphQL endpoints it approves are listed; no operations means any GET. */
export const RealCheckHttpSchema = z
  .object({
    secretRef: SecretRefSchema,
    placement: PlacementSchema,
    operations: z.array(z.string().refine(isRealCheckOperationTemplate, "an operation like `GET /v2/items/{id}`")).max(REAL_CHECK_LIMITS.operations),
    graphqlPaths: z.array(GraphqlPath).max(REAL_CHECK_LIMITS.graphqlPaths),
  })
  .strict()
  .superRefine((http, context) => {
    if (new Set(http.operations).size !== http.operations.length) context.addIssue({ code: "custom", path: ["operations"], message: "an operation is listed once" });
    if (new Set(http.graphqlPaths).size !== http.graphqlPaths.length) context.addIssue({ code: "custom", path: ["graphqlPaths"], message: "a path is listed once" });
  });
export type RealCheckHttp = z.infer<typeof RealCheckHttpSchema>;

// ---- limits

const limitField = (key: keyof RealCheckLimits) => z.number().int().min(1).max(REAL_CHECK_LIMIT_MAXIMUMS[key]);

/** A connection's caps: each from 1 up to Rovara's maximum, and consistent (a check's calls fit inside the project's day, which fits inside the company's; a call fits inside a check). */
export const RealCheckLimitsSchema = z
  .object({
    callsPerCheck: limitField("callsPerCheck"),
    callsPerProjectPerDay: limitField("callsPerProjectPerDay"),
    callsPerCompanyPerDay: limitField("callsPerCompanyPerDay"),
    concurrentChecks: limitField("concurrentChecks"),
    callsPerSecond: limitField("callsPerSecond"),
    msPerCall: limitField("msPerCall"),
    msPerCheck: limitField("msPerCheck"),
    answerBytes: limitField("answerBytes"),
    requestBytes: limitField("requestBytes"),
    bigQueryBytesBilled: limitField("bigQueryBytesBilled"),
  })
  .strict()
  .superRefine((limits, context) => {
    const problem = (key: keyof RealCheckLimits, message: string) => context.addIssue({ code: "custom", path: [key], message });
    if (limits.callsPerCheck > limits.callsPerProjectPerDay) problem("callsPerCheck", "a check's calls fit inside the project's day");
    if (limits.callsPerProjectPerDay > limits.callsPerCompanyPerDay) problem("callsPerProjectPerDay", "a project's day fits inside the company's");
    if (limits.msPerCall > limits.msPerCheck) problem("msPerCall", "a call fits inside a check");
  });

// ---- the record

const DeveloperId = z.string().regex(/^[a-f0-9]{64}$/u);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

/**
 * One person's approval of one exact record. `approvedDigest` is `realCheckApprovalDigest` of what they were shown; an approval of anything else counts for nothing. `notProduction` is the tick on the card ("this is
 * not production"), recorded with the approval.
 */
export const RealCheckApprovalSchema = z
  .object({ by: DeveloperId, at: z.string().datetime(), freshSignIn: z.literal(true), kind: z.enum(REAL_CHECK_APPROVAL_KINDS), approvedDigest: Sha256, notProduction: z.literal(true) })
  .strict();
export type RealCheckApproval = z.infer<typeof RealCheckApprovalSchema>;

/** A connection's host: the shared host rule, never an AI model service (FIX-0518). The model check runs first and on the raw text. */
const RealCheckHostSchema = z.string().superRefine((host, context) => {
  if (isTestAccountModelHost(host)) {
    context.addIssue({ code: "custom", message: TEST_ACCOUNT_MODEL_HOST_SENTENCE });
    return;
  }
  const shared = TestServiceHostSchema.safeParse(host);
  if (!shared.success) for (const issue of shared.error.issues) context.addIssue({ code: "custom", message: issue.message });
});

const RealCheckObjectSchema = z
  .object({
    id: RealCheckConnectionIdSchema,
    orgId: OrgIdSchema,
    projectIds: z.union([z.literal("all"), z.array(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u)).min(1).max(REAL_CHECK_LIMITS.projects)]),
    label: line(80),
    kind: z.enum(REAL_CHECK_KINDS),
    gcp: RealCheckGcpSchema.optional(),
    aws: RealCheckAwsReadSchema.optional(),
    http: RealCheckHttpSchema.optional(),
    /** The exact hosts (no wildcard, no port, no address). */
    hosts: z.array(RealCheckHostSchema).min(1).max(REAL_CHECK_LIMITS.hosts),
    /** Read only, and nothing else in v1 (R3-4). */
    mode: z.enum(REAL_CHECK_MODES),
    limits: RealCheckLimitsSchema,
    approvals: z.array(RealCheckApprovalSchema).max(REAL_CHECK_LIMITS.approvals),
    status: z.enum(REAL_CHECK_STATUSES),
    expiresAt: z.string().datetime().optional(),
    /** Moves on every change of the record; a run is pinned to one. */
    revision: z.number().int().min(1).max(1_000_000),
    /** Moves on suspend, delete and revoke; RealCheckEgress checks it on every call. */
    revocationEpoch: z.number().int().min(0).max(1_000_000),
    lastUsedAt: z.string().datetime().optional(),
  })
  .strict();
export type RealCheckConnection = z.infer<typeof RealCheckObjectSchema>;

export interface RealCheckSchemaOptions {
  /** The install's environment: a secret reference must point into it. */
  env?: string;
  /** A company's shorter expiry, in whole days from 1 to 90. */
  maxExpiryDays?: number;
  /** The company setting that asks for a second approver (R3-3). Off by default; the sole-owner exception still applies. */
  requireSecondAdmin?: boolean;
  /** A company's own model gateway hosts: a connection for one is refused like any model host. */
  gatewayHosts?: readonly string[];
}

const DAY_MS = 86_400_000;

function expiryDaysFor(options: RealCheckSchemaOptions): number {
  const days = options.maxExpiryDays ?? REAL_CHECK_EXPIRY_DAYS.max;
  if (!Number.isInteger(days) || days < 1 || days > REAL_CHECK_EXPIRY_DAYS.max) throw new RangeError("a company may set an expiry of 1 to 90 days, never longer");
  return days;
}

const sorted = (values: readonly string[]): string[] => [...values].sort();
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && new Set(a).size === a.length && a.every((value) => b.includes(value));

/** The hosts a connection must hold: a GCP connection's are its APIs' hosts, an AWS one's the regional endpoints of its actions' services. A plain HTTP connection lists its own. */
export function realCheckExpectedHosts(connection: Pick<RealCheckConnection, "kind" | "gcp" | "aws">): string[] | undefined {
  if (connection.kind === "gcp_federation" && connection.gcp !== undefined) return connection.gcp.apis.map((api) => REAL_CHECK_GOOGLE_HOSTS[api]);
  if (connection.kind === "aws_role_read" && connection.aws !== undefined) return testAccountAwsEndpointHosts(connection.aws);
  return undefined;
}

/** The real-check schema for an install (its environment) and a company (its expiry and second-approver settings). `RealCheckConnectionSchema` is the one with none. */
export function realCheckSchemaFor(options: RealCheckSchemaOptions = {}) {
  const maxDays = expiryDaysFor(options);
  return RealCheckObjectSchema.superRefine((connection, context) => {
    const problem = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
    const blocks = { gcp_federation: connection.gcp, aws_role_read: connection.aws, http_secret_ref: connection.http } as const;
    for (const kind of REAL_CHECK_KINDS) if ((kind === connection.kind) !== (blocks[kind] !== undefined)) problem([kind === "gcp_federation" ? "gcp" : kind === "aws_role_read" ? "aws" : "http"], "a connection has the block of its own kind, and no other");
    if (connection.aws !== undefined && connection.aws.externalId !== realCheckExternalId(connection.orgId, connection.id)) problem(["aws", "externalId"], "the external id is the one Rovara derives for this company and connection");
    const expected = realCheckExpectedHosts(connection);
    if (expected !== undefined && !sameSet(connection.hosts, expected)) problem(["hosts"], "this kind of connection reaches exactly the hosts of what it approves");
    if (new Set(connection.hosts).size !== connection.hosts.length) problem(["hosts"], "a host is listed once");
    if (connection.http !== undefined) {
      const parts = parseRealCheckSecretRef(connection.http.secretRef);
      if (parts !== undefined && (parts.orgId !== connection.orgId || parts.connectionId !== connection.id)) problem(["http", "secretRef"], "the reference points at this connection's own secret in its own org");
      if (parts !== undefined && options.env !== undefined && parts.env !== options.env) problem(["http", "secretRef"], "the reference points into this install's environment");
      // A vendor connection reaches the vendor's host, not Google's APIs (those are the GCP kind's, read through its own table) and not a sign-in host.
      connection.hosts.forEach((host, index) => {
        if (host === "googleapis.com" || host.endsWith(".googleapis.com")) problem(["hosts", index], "Google APIs are reached by a Google Cloud connection");
      });
      const placement = connection.http.placement;
      if (placement.scheme === "oauth_client_credentials") {
        const token = normalizeDenyHost(placement.tokenHost);
        if (token === undefined || token !== placement.tokenHost || hostProblem(token) !== undefined) problem(["http", "placement", "tokenHost"], "a token host is a plain lower-case name");
        else if (isTestAccountModelHost(token, { gatewayHosts: options.gatewayHosts ?? [] })) problem(["http", "placement", "tokenHost"], TEST_ACCOUNT_MODEL_HOST_SENTENCE);
        else if (connection.hosts.includes(token)) problem(["http", "placement", "tokenHost"], "the token host is not a staging host");
      }
    }
    const gatewayHosts = options.gatewayHosts ?? [];
    if (gatewayHosts.length > 0) for (const index of testAccountModelHostProblems(connection.hosts, { gatewayHosts })) if (!isTestAccountModelHost(connection.hosts[index])) problem(["hosts", index], TEST_ACCOUNT_MODEL_HOST_SENTENCE);
    if (connection.projectIds !== "all" && new Set(connection.projectIds).size !== connection.projectIds.length) problem(["projectIds"], "a project is listed once");
    if (looksLikeSecretValue(connection.label)) problem(["label"], "a label is not the place for a key");
    const qualifying = realCheckQualifyingApprovals(connection);
    if (connection.status === "active") {
      if (!realCheckApprovalsSatisfied(qualifying, options)) problem(["approvals"], "an active connection is approved with a fresh sign-in by one admin (two when the company asks, or the sole-owner exception), each approving exactly this record");
      if (connection.expiresAt === undefined) problem(["expiresAt"], "an active connection expires");
    }
    if (connection.expiresAt !== undefined && qualifying.length > 0) {
      const expires = Date.parse(connection.expiresAt);
      const latest = latestAt(qualifying);
      if (expires <= latest) problem(["expiresAt"], "a connection expires after its last approval");
      if (expires - latest > maxDays * DAY_MS) problem(["expiresAt"], `a connection expires within ${String(maxDays)} days of its last approval`);
    }
  });
}
export const RealCheckConnectionSchema = realCheckSchemaFor();

/** The connection, or undefined. Never throws and never returns the reasons. */
export function parseRealCheckConnection(input: unknown, options: RealCheckSchemaOptions = {}): RealCheckConnection | undefined {
  const result = realCheckSchemaFor(options).safeParse(input);
  return result.success ? result.data : undefined;
}

// ---- the approval digest, widening and approvals

/** The fields an approval covers. */
export interface RealCheckApprovable {
  id: string;
  orgId: string;
  kind: string;
  hosts: readonly string[];
  gcp?: { projectId: string; projectNumber?: string | undefined; poolAudience: string; serviceAccount: string; apis: readonly string[] } | undefined;
  aws?: { roleArn: string; externalId: string; region: string; actions: readonly string[]; resources: readonly string[] } | undefined;
  http?: { secretRef: string; placement: unknown; operations: readonly string[]; graphqlPaths: readonly string[] } | undefined;
  projectIds: "all" | readonly string[];
  mode: string;
  limits: RealCheckLimits;
}

/** The digest of the operations the approved Google APIs allow: a change to a row of an approved API changes the digest, so a widened table needs a fresh approval. */
function googleRowsDigest(apis: readonly string[]): string {
  return sha256Hex(canonicalJson(REAL_CHECK_GOOGLE_ROWS.filter((row) => apis.includes(row.api)).map((row) => ({ api: row.api, method: row.method, path: row.path, kind: row.kind, query: sorted(row.query), body: row.body === undefined ? null : sorted(row.body) }))));
}

/** The digest an approval is bound to: canonical JSON of what the approver was shown, with lists in a fixed order. */
export function realCheckApprovalDigest(record: RealCheckApprovable): string {
  return sha256Hex(
    canonicalJson({
      id: record.id,
      orgId: record.orgId,
      kind: record.kind,
      hosts: sorted(record.hosts),
      gcp: record.gcp === undefined ? null : { ...record.gcp, projectNumber: record.gcp.projectNumber ?? null, apis: sorted(record.gcp.apis), operationsDigest: googleRowsDigest(record.gcp.apis) },
      aws: record.aws === undefined ? null : { ...record.aws, actions: sorted(record.aws.actions), resources: sorted(record.aws.resources) },
      http: record.http === undefined ? null : { ...record.http, operations: sorted(record.http.operations), graphqlPaths: sorted(record.http.graphqlPaths) },
      projectIds: record.projectIds === "all" ? "all" : sorted(record.projectIds),
      mode: record.mode,
      limits: record.limits,
    }),
  );
}

const subsetOf = (smaller: readonly string[], larger: readonly string[]): boolean => smaller.every((value) => larger.includes(value));

/**
 * Whether going from `previous` to `next` is a widening: anything this function cannot PROVE is smaller. The same connection, kind, identity (role, pool, service account, secret reference, placement) and mode; no host,
 * API, action, resource, operation, GraphQL path or project that was not there; no higher cap. Listing operations where there were none is a narrowing; emptying the list (any GET) is a widening. Narrowing applies at
 * once; a widening needs a fresh approval.
 */
export function realCheckWidened(previous: RealCheckApprovable, next: RealCheckApprovable): boolean {
  if (previous.id !== next.id || previous.orgId !== next.orgId || previous.kind !== next.kind || previous.mode !== next.mode) return true;
  if (!subsetOf(next.hosts, previous.hosts)) return true;
  if (previous.projectIds !== "all" && (next.projectIds === "all" || !subsetOf(next.projectIds, previous.projectIds))) return true;
  for (const key of REAL_CHECK_LIMIT_KEYS) if (next.limits[key] > previous.limits[key]) return true;
  if ((previous.gcp === undefined) !== (next.gcp === undefined) || (previous.aws === undefined) !== (next.aws === undefined) || (previous.http === undefined) !== (next.http === undefined)) return true;
  if (previous.gcp !== undefined && next.gcp !== undefined) {
    const was = previous.gcp;
    const now = next.gcp;
    if (was.projectId !== now.projectId || (was.projectNumber ?? null) !== (now.projectNumber ?? null) || was.poolAudience !== now.poolAudience || was.serviceAccount !== now.serviceAccount) return true;
    if (!subsetOf(now.apis, was.apis)) return true;
  }
  if (previous.aws !== undefined && next.aws !== undefined) {
    if (previous.aws.roleArn !== next.aws.roleArn || previous.aws.externalId !== next.aws.externalId || previous.aws.region !== next.aws.region) return true;
    if (!subsetOf(next.aws.actions, previous.aws.actions) || !subsetOf(next.aws.resources, previous.aws.resources)) return true;
  }
  if (previous.http !== undefined && next.http !== undefined) {
    if (previous.http.secretRef !== next.http.secretRef || canonicalJson(previous.http.placement) !== canonicalJson(next.http.placement)) return true;
    if (previous.http.operations.length > 0 && (next.http.operations.length === 0 || !subsetOf(next.http.operations, previous.http.operations))) return true;
    if (!subsetOf(next.http.graphqlPaths, previous.http.graphqlPaths)) return true;
  }
  return false;
}

/**
 * The approvals that approved exactly this record. With `now`, an approval dated after it does not count (a future date is no approval yet, and a date that is not a date never counts).
 */
export function realCheckQualifyingApprovals(record: RealCheckApprovable & { approvals: readonly RealCheckApproval[] }, now?: number): RealCheckApproval[] {
  const digest = realCheckApprovalDigest(record);
  return record.approvals.filter((approval) => approval.approvedDigest === digest && (now === undefined || Date.parse(approval.at) <= now));
}

/**
 * Whether the approvals are enough: ONE approver with a fresh sign-in by default (R3-3, DEC 124); two different people when the company asks for a second admin; the sole-owner exception stands in for the second
 * person. Only qualifying approvals are passed in.
 */
export function realCheckApprovalsSatisfied(qualifying: readonly RealCheckApproval[], options: { requireSecondAdmin?: boolean } = {}): boolean {
  if (qualifying.length === 0) return false;
  if (options.requireSecondAdmin !== true) return true;
  return new Set(qualifying.map((approval) => approval.by)).size >= 2 || qualifying.some((approval) => approval.kind === "sole_owner_exception");
}

const latestAt = (approvals: readonly RealCheckApproval[]): number => Math.max(0, ...approvals.map((approval) => Date.parse(approval.at)));

/**
 * Whether a record may be used at `now`: active, approved as exactly this record (by `now`), not expired (`now` before `expiresAt`), and its expiry within the company's window of the last approval. Anything
 * unreadable (a date that is not a date) is not usable.
 */
export function isRealCheckConnectionUsableAt(record: RealCheckConnection, now: Date | number | string, options: RealCheckSchemaOptions = {}): boolean {
  const at = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(at) || record.status !== "active" || record.expiresAt === undefined) return false;
  const expires = Date.parse(record.expiresAt);
  if (!Number.isFinite(expires) || at >= expires) return false;
  const qualifying = realCheckQualifyingApprovals(record, at);
  if (!realCheckApprovalsSatisfied(qualifying, options)) return false;
  return expires - latestAt(qualifying) <= expiryDaysFor(options) * DAY_MS;
}

// ---- production (R3-8)

export type RealCheckProdProblem = {
  kind: "prod_host" | "prod_arn" | "prod_account" | "prod_deny_missing" | "prod_shaped_host" | "vendor_production_host" | "rovara_account" | "model_host" | "prod_gcp_project" | "prod_shaped_project";
  field: string;
};

const PROD_WORD = /(?:^|[^a-z0-9])(?:prod|production|prd|live)(?:[^a-z0-9]|$)/iu;

/** Whether the labels of a Google Cloud project say production: `env` or `environment` is prod, production, prd or live (any case). The connect probe reads them with `projects.get`. */
export function realCheckGcpLabelsLookProduction(labels: Readonly<Record<string, unknown>> | undefined): boolean {
  if (labels === undefined) return false;
  return Object.entries(labels).some(([key, value]) => (key.toLowerCase() === "env" || key.toLowerCase() === "environment") && typeof value === "string" && /^(?:prod|production|prd|live)$/iu.test(value.trim()));
}

/** Whether an AWS account alias says production (contains `prod`, or the word `prd` or `live`). */
export function realCheckAwsAliasLooksProduction(alias: unknown): boolean {
  return typeof alias === "string" && (/prod/iu.test(alias) || /(?:^|[^a-z0-9])(?:prd|live)(?:[^a-z0-9]|$)/iu.test(alias));
}

/**
 * Everything in the connection that names production, as fixed codes with the field they were found in: a host on the list or one that looks like production, a role or resource on it, an AWS account that is
 * Rovara's own, a Google Cloud project (id or number) on the list or one named like production, a model host, or `prod_deny_missing` when the company has listed nothing at all (a connection reaches a real remote,
 * so the list must exist first). `alsoDeny` is the list the approved connection had, so removing an entry in the same change that points at it hides nothing.
 */
export function realCheckProdProblems(connection: RealCheckConnection, deny: RealCheckProdDeny, options: { alsoDeny?: RealCheckProdDeny; rovaraAccountIds?: readonly string[]; modelGatewayHosts?: readonly string[] } = {}): RealCheckProdProblem[] {
  const lists = options.alsoDeny === undefined ? [deny] : [deny, options.alsoDeny];
  const hosts = [...connection.hosts];
  const hostFields = connection.hosts.map((_, index) => `hosts[${String(index)}]`);
  const placement = connection.http?.placement;
  if (placement?.scheme === "oauth_client_credentials") {
    hosts.push(placement.tokenHost);
    hostFields.push("http.placement.tokenHost");
  }
  const found: RealCheckProdProblem[] = testAccountModelHostProblems(hosts, { gatewayHosts: options.modelGatewayHosts ?? [] }).map((index) => ({ kind: "model_host" as const, field: hostFields[index] as string }));
  const listEmpty = (list: RealCheckProdDeny): boolean => prodDenyIsEmpty(list) && (list.gcpProjects ?? []).length === 0;
  if (lists.every(listEmpty)) return [...found, { kind: "prod_deny_missing", field: "prodDeny" }];
  hosts.forEach((host, index) => {
    if (lists.some((list) => prodDenyMatchesHost(list, host))) found.push({ kind: "prod_host", field: hostFields[index] as string });
  });
  for (const problem of testAccountHostProblems(hosts)) found.push({ kind: problem.code, field: hostFields[problem.index] as string });
  if (connection.gcp !== undefined) {
    const ids = [connection.gcp.projectId, connection.gcp.projectNumber].filter((value): value is string => value !== undefined).map((value) => value.toLowerCase());
    if (lists.some((list) => (list.gcpProjects ?? []).some((entry) => ids.includes(entry.toLowerCase())))) found.push({ kind: "prod_gcp_project", field: "gcp.projectId" });
    if (PROD_WORD.test(connection.gcp.projectId)) found.push({ kind: "prod_shaped_project", field: "gcp.projectId" });
  }
  if (connection.aws !== undefined) {
    const arns = [{ field: "aws.roleArn", arn: connection.aws.roleArn }, ...connection.aws.resources.map((arn, index) => ({ field: `aws.resources[${String(index)}]`, arn }))];
    for (const { field, arn } of arns) {
      const kind = lists.map((list) => prodDenyMatchesArn(list, arn)).find((match) => match !== undefined);
      if (kind !== undefined) found.push({ kind, field });
    }
    const own = arnField(connection.aws.roleArn, 4);
    if (own !== undefined && (options.rovaraAccountIds ?? []).includes(own)) found.push({ kind: "rovara_account", field: "aws.roleArn" });
  }
  return found;
}

// ---- the run grant (design 3.1): what lets ONE run ask RealCheckEgress for ONE connection

const RunPart = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);

/**
 * The payload the broker signs for ONE run: one company, one project, one connection at one revision and one approval digest, for 15 to 30 minutes, at the connection's revocation epoch of the moment. The
 * worker holds it and cannot forge one (the signature is the broker's, a later lane); a stolen live grant is worth the rest of one run's caps on one read-only connection. No credential is in it.
 */
export const RealCheckRunGrantSchema = z
  .object({
    orgId: OrgIdSchema,
    projectId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u),
    connectionId: RealCheckConnectionIdSchema,
    revision: z.number().int().min(1).max(1_000_000),
    approvalDigest: Sha256,
    revocationEpoch: z.number().int().min(0).max(1_000_000),
    taskId: RunPart,
    runId: RunPart,
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .superRefine((grant, context) => {
    const seconds = (Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt)) / 1_000;
    if (!(seconds >= REAL_CHECK_GRANT_SECONDS.min && seconds <= REAL_CHECK_GRANT_SECONDS.max)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "a grant lives 15 to 30 minutes" });
  });
export type RealCheckRunGrant = z.infer<typeof RealCheckRunGrantSchema>;

/** The grant, or undefined. Never throws and never returns the reasons. */
export function parseRealCheckRunGrant(input: unknown): RealCheckRunGrant | undefined {
  const result = RealCheckRunGrantSchema.safeParse(input);
  return result.success ? result.data : undefined;
}

export type RealCheckGrantProblem = "org" | "project" | "connection" | "revision" | "digest" | "epoch" | "status" | "grant_time";

/**
 * Why a grant does not match the connection it names right now, as fixed codes (empty: it does). The company is the CONNECTION's own, so a grant minted for another company's connection id matches nothing. A changed
 * record (revision or digest), a moved epoch (suspend, delete, revoke), a connection that is not usable at `now` and a grant outside its own time are each a code.
 */
export function realCheckGrantProblems(grant: RealCheckRunGrant, connection: RealCheckConnection, now: Date | number | string, options: RealCheckSchemaOptions = {}): RealCheckGrantProblem[] {
  const at = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(now);
  const found: RealCheckGrantProblem[] = [];
  if (grant.orgId !== connection.orgId) found.push("org");
  if (grant.connectionId !== connection.id) found.push("connection");
  if (connection.projectIds !== "all" && !connection.projectIds.includes(grant.projectId)) found.push("project");
  if (grant.revision !== connection.revision) found.push("revision");
  if (grant.approvalDigest !== realCheckApprovalDigest(connection)) found.push("digest");
  if (grant.revocationEpoch !== connection.revocationEpoch) found.push("epoch");
  if (!isRealCheckConnectionUsableAt(connection, at, options)) found.push("status");
  const issued = Date.parse(grant.issuedAt);
  const expires = Date.parse(grant.expiresAt);
  if (!Number.isFinite(at) || !Number.isFinite(issued) || !Number.isFinite(expires) || at < issued || at >= expires) found.push("grant_time");
  return found;
}

// ---- caps: the one place a counter is judged (R3-5)

export interface RealCheckUsage {
  /** Calls already made in this check. */
  callsInCheck: number;
  /** Calls already made by this project today (UTC). */
  callsProjectToday: number;
  /** Calls already made by this company today (UTC). */
  callsCompanyToday: number;
  /** Checks already running on this connection (not counting this one). */
  concurrentChecks: number;
  /** Milliseconds this check has run. */
  checkElapsedMs: number;
  /** Calls already started in the current second of this check. */
  callsThisSecond: number;
}

export type RealCheckCapCode = "calls_per_check" | "calls_per_project_day" | "calls_per_company_day" | "concurrent_checks" | "check_time" | "rate";

/** A counter that is not a whole non-negative number is not a counter: the answer is a refusal, never a pass. */
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Whether the NEXT call fits every cap, judged BEFORE the call. Counts are what already happened, so a call is allowed while each count is below its limit. Any counter or limit that is not a plain whole number is a
 * refusal (fail closed). The first cap that is full is the one named.
 */
export function realCheckCapDecision(limits: RealCheckLimits, usage: RealCheckUsage): { ok: true } | { ok: false; cap: RealCheckCapCode } {
  const checks: Array<[RealCheckCapCode, unknown, unknown]> = [
    ["concurrent_checks", usage.concurrentChecks, limits.concurrentChecks],
    ["calls_per_company_day", usage.callsCompanyToday, limits.callsPerCompanyPerDay],
    ["calls_per_project_day", usage.callsProjectToday, limits.callsPerProjectPerDay],
    ["calls_per_check", usage.callsInCheck, limits.callsPerCheck],
    ["check_time", usage.checkElapsedMs, limits.msPerCheck],
    ["rate", usage.callsThisSecond, limits.callsPerSecond],
  ];
  for (const [cap, used, limit] of checks) if (!isCount(used) || !isCount(limit) || used >= limit) return { ok: false, cap };
  return { ok: true };
}

/** The deadline for the next call in milliseconds: the per-call cap, or what is left of the check's time when that is less. Undefined when the check has no time left (or a figure is not a plain number). */
export function realCheckCallDeadlineMs(limits: RealCheckLimits, checkElapsedMs: number): number | undefined {
  if (!isCount(checkElapsedMs) || !isCount(limits.msPerCall) || !isCount(limits.msPerCheck)) return undefined;
  const left = limits.msPerCheck - checkElapsedMs;
  return left <= 0 ? undefined : Math.min(limits.msPerCall, left);
}

/** Whether an answer of this many bytes fits the answer cap (a figure that is not a plain number does not). */
export const realCheckAnswerWithinCap = (bytes: number, limits: Pick<RealCheckLimits, "answerBytes">): boolean => isCount(bytes) && isCount(limits.answerBytes) && bytes <= limits.answerBytes;

/** Whether a request body of this many bytes fits the request cap. */
export const realCheckRequestWithinCap = (bytes: number, limits: Pick<RealCheckLimits, "requestBytes">): boolean => isCount(bytes) && isCount(limits.requestBytes) && bytes <= limits.requestBytes;

// ---- the ledger row (5.3): one row per call, never a body, a query value, a header or a token

export const REAL_CHECK_LEDGER_REASONS = ["write", "not_allowed", "host_not_allowed", "cap", "prod", "model_host", "private_address", "expired", "revoked", "unreadable"] as const;
export type RealCheckLedgerReason = (typeof REAL_CHECK_LEDGER_REASONS)[number];

/** The label the classifier writes: the method, the host and a path in which every non-word segment is `{id}` (or a table row's own template). A segment with a digit (an id, a number) does not fit this shape, and neither does a query string. */
const LEDGER_SEGMENT = String.raw`(?:[a-z][A-Za-z_-]{0,23}(?::[A-Za-z]{1,24})?|v\d{1,2}(?:alpha\d{0,2}|beta\d{0,2})?|\{[a-z]{1,8}\*?\}(?::[A-Za-z]{1,24})?|…)`;
const LEDGER_OPERATION = new RegExp(String.raw`^[A-Z?]{1,10} [a-z0-9.?-]{1,253} \/(?:${LEDGER_SEGMENT}(?:\/${LEDGER_SEGMENT}){0,15})?(?: \(query\))?$`, "u");

export const RealCheckLedgerRowSchema = z
  .object({
    at: z.string().datetime(),
    orgId: OrgIdSchema,
    projectId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u),
    taskId: RunPart,
    runId: RunPart,
    connectionId: RealCheckConnectionIdSchema,
    operation: z.string().max(600).regex(LEDGER_OPERATION, "an operation label"),
    decision: z.enum(["allowed", "refused"]),
    reason: z.enum(REAL_CHECK_LEDGER_REASONS).optional(),
    status: z.number().int().min(100).max(599).optional(),
    bytes: z.number().int().min(0).max(100_000_000).optional(),
    ms: z.number().int().min(0).max(1_000_000).optional(),
    /** The identity used: a service account address, a role ARN, or the connection's own label for a vendor key. A line that looks like a key is refused. */
    identity: line(200),
  })
  .strict()
  .superRefine((row, context) => {
    if ((row.decision === "refused") !== (row.reason !== undefined)) context.addIssue({ code: "custom", path: ["reason"], message: "a refused call has a reason, an allowed one has none" });
    if (looksLikeSecretValue(row.identity)) context.addIssue({ code: "custom", path: ["identity"], message: "an identity is not the place for a key" });
  });
export type RealCheckLedgerRow = z.infer<typeof RealCheckLedgerRowSchema>;

/** The ledger row for one verdict, or undefined when it does not fit the row's shape (nothing is written then; the caller refuses the call). A refused verdict's reason is the classifier's own. */
export function realCheckLedgerRowFor(input: { at: string; grant: RealCheckRunGrant; verdict: RealCheckVerdict; identity: string; status?: number; bytes?: number; ms?: number }): RealCheckLedgerRow | undefined {
  const { grant, verdict } = input;
  const row = {
    at: input.at,
    orgId: grant.orgId,
    projectId: grant.projectId,
    taskId: grant.taskId,
    runId: grant.runId,
    connectionId: grant.connectionId,
    operation: verdict.operation,
    decision: verdict.allow ? "allowed" : "refused",
    ...(verdict.allow ? {} : { reason: verdict.reason }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.bytes === undefined ? {} : { bytes: input.bytes }),
    ...(input.ms === undefined ? {} : { ms: input.ms }),
    identity: input.identity,
  };
  const parsed = RealCheckLedgerRowSchema.safeParse(row);
  return parsed.success ? parsed.data : undefined;
}

// ---- fixed words (7.4): one line each, never the text of a request

export const REAL_CHECK_WORDS = {
  write: "Real check stopped a call: it changes data, and this check is read-only.",
  not_allowed: "Real check stopped a call: it is not one of the reads this check allows.",
  host_not_allowed: "Real check stopped a call to an address that is not on this check's list. An admin can add it.",
  prod: "Real check refused: that address is on your production list.",
  model_host: "Real check refused: that address is an AI model service. AI calls go through Rovara's model helper.",
  private_address: "Real check refused: that address is not one Rovara may reach.",
  unreadable: "Real check stopped a call it could not read.",
  calls_per_check: "Real check not run: this check used all of its calls.",
  calls_per_project_day: "Real check not run: this project's daily limit is used. The next check can run after 00:00 UTC.",
  calls_per_company_day: "Real check not run: your company's daily limit is used. The next check can run after 00:00 UTC.",
  concurrent_checks: "Real check not run: too many checks are running on this connection. Try again in a few minutes.",
  check_time: "Real check not run: this check used all of its time.",
  rate: "Real check slowed down: too many calls in one second.",
  expired: "Real check not run: this check has expired. An admin can renew it.",
  revoked: "Real check not run: turned off by an admin.",
  customer_cloud_refused: "Real check not run: your cloud refused Rovara's sign-in. The setup may need a fix.",
  staging_down: "Real check not run: your staging did not answer in time. Not your code's fault as far as Rovara can tell.",
  private_network: "Real check not run: your staging has no address Rovara can reach (private network only).",
  rovara_problem: "Real check not run: Rovara problem, not your code. The checker did not answer.",
} as const satisfies Record<string, string>;
export type RealCheckWordKey = keyof typeof REAL_CHECK_WORDS;

/**
 * The words for a refusal or a cap, with the call's cleaned label after them when it has one. The label is checked against the ledger's own shape first, so a caller cannot put free text into a sentence.
 */
export function realCheckWordsFor(key: RealCheckWordKey, operation?: string): string {
  const words = REAL_CHECK_WORDS[key];
  return operation !== undefined && LEDGER_OPERATION.test(operation) ? `${words} (${operation})` : words;
}
