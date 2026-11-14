// IF2, decision 160: a company account may issue short-lived credentials for ONE named purpose.
import { z } from "zod";
import type { OrgId } from "../browser-ids.js";
import { SecretValue } from "./model-keys.js";
import type { ExternalAccountRef } from "./policy.js";

export const CLOUD_ACCOUNT_PURPOSES = ["invoke_only_endpoint", "device_farm_project", "recording_bucket", "test_account_confirm"] as const;
export const CloudAccountPurposeSchema = z.enum(CLOUD_ACCOUNT_PURPOSES);
export type CloudAccountPurpose = z.infer<typeof CloudAccountPurposeSchema>;
export const CLOUD_ACCOUNT_MAX_LIFETIME_SECONDS = 3600;
const CLOCK_SKEW_MARGIN_SECONDS = 60;

/** Provider-discriminated credentials; AWS is the only approved member today. Never persist or log revealed material. */
export type CloudAccountCredentials = {
  readonly provider: "aws";
  readonly accessKeyId: SecretValue;
  readonly secretAccessKey: SecretValue;
  readonly sessionToken: SecretValue;
  /** Unix seconds. Expired at now is refused; the 3600-second maximum allows 60 seconds of clock skew, never shortened. */
  readonly expiresAt: number;
};

/** The same fixed refusal for missing accounts, wrong companies/purposes, invalid credentials and provider failures. No input, cause or provider error. */
export class CloudAccountRefusedError extends Error {
  constructor() {
    super("cloud account unavailable");
    this.name = "CloudAccountRefusedError";
  }
}

const CredentialsSchema = z.object({
  provider: z.literal("aws"),
  accessKeyId: z.instanceof(SecretValue),
  secretAccessKey: z.instanceof(SecretValue),
  sessionToken: z.instanceof(SecretValue),
  expiresAt: z.number().int().nonnegative(),
}).strict();

/** Check immediately before returning provider material (after awaiting I/O), and again before using a held credential. Clock units are seconds. */
export function assertCloudAccountCredentials(value: unknown, nowSeconds: number): asserts value is CloudAccountCredentials {
  const parsed = CredentialsSchema.safeParse(value);
  if (!parsed.success || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0) throw new CloudAccountRefusedError();
  const lifetime = parsed.data.expiresAt - nowSeconds;
  if (lifetime <= 0 || lifetime > CLOUD_ACCOUNT_MAX_LIFETIME_SECONDS + CLOCK_SKEW_MARGIN_SECONDS) throw new CloudAccountRefusedError();
}

/** Every method must validate companyId with OrgIdSchema and refuse an invalid id before accessing provider state. */
export interface CloudAccount {
  /**
   * Resolve the full reference inside companyId on every call. No fallback to another company or purpose.
   * The adapter must restrict the provider credentials to exactly this purpose's configured resource/permissions;
   * this enum alone does not impose a provider policy. Refuse if that restriction cannot be guaranteed.
   * Validate with assertCloudAccountCredentials immediately before returning; the provider must match accountRef.provider. All secret fields stay SecretValue.
   * No credential persistence. Failures throw CloudAccountRefusedError, never an upstream error or free text.
   */
  credentialsFor(companyId: OrgId, accountRef: ExternalAccountRef, purpose: CloudAccountPurpose): Promise<CloudAccountCredentials>;
  /** Resolve and check this company's connection without returning/issuing credentials. Success is void; every failure is CloudAccountRefusedError. */
  testConnection(companyId: OrgId, accountRef: ExternalAccountRef): Promise<void>;
  /** Stable for this company across its accounts; never reuse another company's external id. Unavailable/invalid scope throws CloudAccountRefusedError. */
  externalIdFor(companyId: OrgId): Promise<string>;
}
