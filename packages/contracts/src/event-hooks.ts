// Event hooks (Plan 4 Task 19): the endpoint a vendor posts events to (`POST /v1/hooks/{source}/{hookId}`), what a hook record holds, the limits of the endpoint and the keys the
// hook, its lookup, its de-duplication items and its rate counter live under. A hook's secret is never part of the record: it is kept by Plan 3's `HookSecretStore`.
import { createHash } from "node:crypto";
import { z } from "zod";
import { DnsHostSchema } from "./mcp-connector.js";
import { type OrgId } from "./company-scope.js";
import { orgScoped, type OrgKey } from "./company-scope.js";
import { EVENT_SOURCES, type EventSource } from "./trigger-specs.js";

// ---- limits

/** An event older than this (by its own signed time) is not started, and one more than `EVENT_MAX_FUTURE_MINUTES` ahead is not either. */
export const EVENT_MAX_AGE_HOURS = 24;
/** How far ahead of the broker's clock an event's own time may be. Without it a signed body dated far ahead could be replayed after its de-duplication item expired. */
export const EVENT_MAX_FUTURE_MINUTES = 5;
/** Longer than `EVENT_MAX_AGE_HOURS` plus `EVENT_MAX_FUTURE_MINUTES`, so a replayed signed body is either de-duplicated or too old. */
export const EVENT_DEDUPE_TTL_HOURS = 72;
export const HOOK_BODY_MAX_BYTES = 1_048_576;
export const HOOK_MAX_DELIVERIES_PER_MINUTE = 120;
export const HOOK_ROTATION_OVERLAP_HOURS = 24;
/** Both counted in memory, per broker container. */
export const HOOK_PRE_VERIFY_PER_IP_PER_MINUTE = 600;
export const HOOK_FAILED_VERIFY_PER_MINUTE = 30;
export const HOOK_SECRET_REREAD_MIN_AGE_SECONDS = 30;
/** The most events one delivery may start; the rest are dropped and logged (a vendor's group notification is far smaller). */
export const HOOK_MAX_EVENTS_PER_DELIVERY = 50;
/** The most bytes of a signing certificate an SNS certificate fetch may read (Amazon's are about 1.5 KB). */
export const SNS_CERT_MAX_BYTES = 16_384;
/** How long a container keeps an SNS signing certificate it fetched, by its URL. */
export const SNS_CERT_CACHE_HOURS = 24;
/** The most certificates not yet cached one container fetches a minute, so forged messages naming varied certificate paths can't become a stream of fetches. */
export const SNS_CERT_FETCHES_PER_MINUTE = 10;
/** The deadline of one certificate fetch or subscription confirmation. */
export const SNS_FETCH_TIMEOUT_MS = 5_000;
/** A secret a person supplies for a vendor-origin hook. */
export const HOOK_SECRET_MIN_CHARS = 16;
export const HOOK_SECRET_MAX_CHARS = 512;

// ---- the record

export const HOOK_SOURCES = EVENT_SOURCES.filter((source): source is Exclude<EventSource, "github"> => source !== "github");
export const HookSourceSchema = z.enum(HOOK_SOURCES as unknown as [Exclude<EventSource, "github">, ...Array<Exclude<EventSource, "github">>]);
export type HookSource = z.infer<typeof HookSourceSchema>;

export const HookIdSchema = z.string().regex(/^hk_[0-9a-z]{26}$/);

const Uuid = z.string().uuid();
const Printable = (max: number) => z.string().min(1).max(max).refine((text) => !/[\p{Cc}\p{Cf}]/u.test(text), "must not contain control characters");

/**
 * The commercial AWS regions a hook's SNS topic may be in: a geography, a direction and a number (`us-west-2`, `ap-southeast-4`). A looser pattern accepts `s3`, which would make the
 * trusted SNS host `sns.s3.amazonaws.com`, an S3 address. The China (`cn-`) and US government (`us-gov-`) partitions have other SNS hosts and are not accepted.
 */
export const SNS_REGION_PATTERN = "(?:us|eu|ap|sa|ca|me|af|il|mx)-[a-z]+-\\d";

/** What a hook is bound to at the vendor, by source: the body of every delivery must name it, or the delivery is refused (the tenant check of each provider). */
export const HOOK_TENANT_SCHEMAS = {
  linear: z.object({ organizationId: Uuid, teamId: Uuid }).strict(),
  jira: z.object({ siteHost: z.string().regex(/^[a-z0-9-]+\.atlassian\.net$/), projectKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,49}$/).optional() }).strict(),
  pagerduty: z.object({ subdomain: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), serviceIds: z.array(z.string().regex(/^[A-Z0-9]{1,32}$/)).min(1).max(50).optional() }).strict(),
  sentry: z.object({ installationUuid: Uuid }).strict(),
  datadog: z.object({ datadogOrgId: Printable(64) }).strict(),
  grafana: z.object({ host: DnsHostSchema }).strict(),
  vercel: z.object({ teamId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(), projectId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional() }).strict(),
  cloudwatch: z.object({
    awsAccountId: z.string().regex(/^\d{12}$/),
    topicArn: z.string().regex(new RegExp(`^arn:aws:sns:${SNS_REGION_PATTERN}:\\d{12}:[A-Za-z0-9_-]{1,256}$`)),
  }).strict().refine((tenant) => tenant.topicArn.split(":")[4] === tenant.awsAccountId, "the topic's account must be the AWS account id"),
} as const satisfies Record<HookSource, z.ZodType>;

export type HookTenantOf<S extends HookSource> = z.infer<(typeof HOOK_TENANT_SCHEMAS)[S]>;
export type HookTenant = { [S in HookSource]: HookTenantOf<S> }[HookSource];

export const HOOK_AUTHS = ["hmac", "token", "sns"] as const;
export const HOOK_STATUSES = ["active", "pending_confirmation", "unsubscribed", "disabled"] as const;
export type HookStatus = (typeof HOOK_STATUSES)[number];

export interface HookRecord {
  orgId: OrgId;
  hookId: string;
  source: HookSource;
  project: string;
  tenant: HookTenant;
  auth: (typeof HOOK_AUTHS)[number];
  /** False for an SNS hook, which has none. */
  hasSecret: boolean;
  status: HookStatus;
  subscriptionArn?: string;
  createdBy: string;
  createdAt: string;
  lastDeliveryAt?: string;
  /** The request that last rotated the secret, so a repeat of it is told apart from a new rotation (the secret itself is shown once and kept nowhere). */
  rotationRequestId?: string;
  rotatedAt?: string;
}

/** What a stored hook secret says: the current value, and the one it replaced until `previousValidUntil` so that the vendor's setting can be changed without dropped events. */
export const HookSecretSchema = z.object({
  current: z.string().min(1).max(HOOK_SECRET_MAX_CHARS),
  previous: z.string().min(1).max(HOOK_SECRET_MAX_CHARS).optional(),
  previousValidUntil: z.string().datetime().optional(),
}).strict();
export type HookSecret = z.infer<typeof HookSecretSchema>;

/** The body of `POST /v1/app/projects/{p}/event-hooks`. The tenant is checked against the source's own schema by the route. */
export const CreateHookBodySchema = z.object({
  requestId: z.string().uuid(),
  source: HookSourceSchema,
  tenant: z.unknown(),
  secret: z.string().min(HOOK_SECRET_MIN_CHARS).max(HOOK_SECRET_MAX_CHARS).refine((text) => !/[\p{Cc}\p{Cf}]/u.test(text), "must not contain control characters").optional(),
}).strict();

export const RotateHookBodySchema = z.object({
  requestId: z.string().uuid(),
  secret: CreateHookBodySchema.shape.secret,
}).strict();

// ---- keys

/** The hook's record. */
export function hookKey(orgId: OrgId, hookId: string): OrgKey {
  return { pk: orgScoped(orgId, `HOOK#${hookId}`), sk: "META" };
}

/** The global lookup from a hook id to its org (`{ orgId }` only), which a delivery reads before it knows whose it is. */
export function hookLookupKey(hookId: string): OrgKey {
  return { pk: `HOOK#${hookId}`, sk: "ORG" };
}

/** The org's list of hooks, for listing them and for closing the org. */
export function hookDirectoryKey(orgId: OrgId, hookId: string): OrgKey {
  return { pk: orgScoped(orgId, "HOOKS"), sk: hookId };
}

/** One event a hook received, so a replay of it is seen: the sort key is the hash of the event key, which the signed body names. It expires with `EVENT_DEDUPE_TTL_HOURS`. */
export function hookEventKey(orgId: OrgId, hookId: string, eventKey: string): OrgKey {
  return { pk: orgScoped(orgId, `HOOK_EVENT#${hookId}`), sk: createHash("sha256").update(eventKey, "utf8").digest("hex") };
}

/** The count of verified deliveries a hook received in one UTC minute (`minute` is `YYYY-MM-DDTHH:MM`). */
export function hookRateKey(orgId: OrgId, hookId: string, minute: string): OrgKey {
  return { pk: orgScoped(orgId, `HOOK_RATE#${hookId}`), sk: minute };
}
