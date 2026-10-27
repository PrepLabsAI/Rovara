import { z } from "zod";
import { WEB_API_RUNTIME_PROFILE_ID } from "./e2e-web-api-qualification.js";
import { E2E_QUALIFICATION_INSTANCE_ID_PATTERN, E2E_QUALIFICATION_ROLE_ID_PATTERN } from "./session.js";

/**
 * AUTOREQUALIFY (AR-1): the product renews its own browser and API test machine. These are the fixed names the renewal, its audit record and
 * its IAM scope share; nothing here is free text from a runner.
 */

/** The only runtime profile the renewal may qualify. */
export const REQUALIFY_PROFILE_ID = WEB_API_RUNTIME_PROFILE_ID;

/** The service identity that stands in for the administrator sign-in on this one registration. It is never produced by the JWT authenticator and has no HTTP route. */
export const REQUALIFIER_ISSUER = "rovara:internal" as const;
export const requalifierSubject = (environment: string): string => `runtime-requalifier/${environment}`;

export const REQUALIFY_ENVIRONMENT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** The tags every renewal-managed runner and volume carries. IAM allows terminating or deleting only resources that carry all three tags and the environment. */
export const REQUALIFY_TAGS = {
  deploymentModeKey: "DeploymentMode", deploymentModeValue: "e2e-qualification",
  environmentKey: "Environment",
  managedKey: "agentx:requalify-managed", managedValue: "true",
  runKey: "agentx:qualification-run",
} as const;

/** Why a renewal step refused or gave up. The alert and the run record carry only these codes. */
export const REQUALIFY_REASON_CODES = [
  "launch-failed", "not-ready", "qualification-failed", "drain-timeout", "retire-failed", "cost-guard",
  "wrong-profile", "binding-mismatch", "endpoint-not-managed-instance", "generation-not-next", "challenge-not-requalifier",
  "lock-not-held", "runner-pointer-invalid", "runner-changed", "invalid-input",
] as const;
export type RequalifyReasonCode = (typeof REQUALIFY_REASON_CODES)[number];
export const RequalifyReasonCodeSchema = z.enum(REQUALIFY_REASON_CODES);

/** The message prefix of a refusal: `requalify-refused:<code>`. */
export const REQUALIFY_REFUSAL_PREFIX = "requalify-refused:";

const RunnerIdentitySchema = z.object({
  instanceId: z.string().regex(E2E_QUALIFICATION_INSTANCE_ID_PATTERN),
  roleId: z.string().regex(E2E_QUALIFICATION_ROLE_ID_PATTERN),
  transportCorrelationId: z.string().uuid(),
}).strict();
export type RequalifyRunnerIdentity = z.infer<typeof RunnerIdentitySchema>;
const ImageRefSchema = z.string().min(1).max(300).regex(/^[A-Za-z0-9._:/@+=-]+$/);

/** Where a renewal run and its single-flight lock live. The lock is held by one run at a time; the switch refuses unless it is still held by the switching run. */
export const requalifyRunKey = (runId: string) => ({ pk: `RUNTIME_REQUALIFY_RUN#${runId}`, sk: "RECORD" });
export const requalifyLockKey = (profileId: string) => ({ pk: `RUNTIME_REQUALIFY#${profileId}`, sk: "LOCK" });

/** The `toISOString` form only: the switch compares the lock's expiry as a string inside its transaction, which is correct only for one fixed-width format. */
const ISO_MILLIS = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
export const RequalifyLockSchema = z.object({
  entityType: z.literal("RUNTIME_REQUALIFY_LOCK"), runId: z.string().uuid(), acquiredAt: ISO_MILLIS, expiresAt: ISO_MILLIS,
}).strict();

/** The audit record of one committed switch: written in the same transaction that moves the rows, so it exists exactly when the switch happened. */
export const RequalifyRunRecordSchema = z.object({
  schemaVersion: z.literal(1),
  entityType: z.literal("RUNTIME_REQUALIFY_RUN"),
  runId: z.string().uuid(),
  environment: z.string().regex(REQUALIFY_ENVIRONMENT_PATTERN),
  profileId: z.literal(REQUALIFY_PROFILE_ID),
  requestedBySubject: z.string().min(1).max(100),
  switchedAt: z.string().datetime(),
  generation: z.number().int().positive(),
  featureRevisions: z.object({ web: z.number().int().positive(), api: z.number().int().positive() }).strict(),
  proposalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  challengeId: z.string().uuid(),
  newRunner: RunnerIdentitySchema,
  /** The runner the model-check pointer named before the switch; null when nothing was recorded. The retire step terminates only this one. */
  previousRunner: RunnerIdentitySchema.nullable(),
  amiId: z.string().regex(/^ami-[0-9a-f]{8,17}$/).nullable(),
  images: z.object({ worker: ImageRefSchema.nullable(), executor: ImageRefSchema.nullable() }).strict(),
}).strict();
export type RequalifyRunRecord = z.infer<typeof RequalifyRunRecordSchema>;
