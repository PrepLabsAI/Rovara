import { createHash } from "node:crypto";
import {
  canonicalJson, Ec2RuntimeBindingSchema, ProjectSetupRunnerEnvironmentSchema, ProjectSetupRunnerToolchainSchema, type Ec2RuntimeBinding,
  E2ERegisteredRuntimeSchema, type E2ERegisteredRuntime,
} from "@agentx/contracts";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime();
export const E2E_FEATURE_PROCESS_RESPONSE_SCOPE = "portable-process-response/v1" as const;

/** Operator-managed feature-verifier authority is distinct from source-only project setup readiness. */
export const E2EFeatureVerifierRecordSchema = z.object({
  schemaVersion: z.literal(1), entityType: z.literal("E2E_FEATURE_VERIFIER"),
  runtimeCatalogId: z.string().min(1).max(160), catalogRevision: z.number().int().positive(),
  profileId: z.string().min(1).max(120), bindingDigest: digest, binding: Ec2RuntimeBindingSchema, manifestDigest: digest,
  runnerEnvironmentDigest: digest, runnerEnvironment: ProjectSetupRunnerEnvironmentSchema,
  runnerToolchainDigest: digest, runnerToolchain: ProjectSetupRunnerToolchainSchema,
  endpoint: z.string().url().max(512), generation: z.number().int().positive(), transportCorrelationId: z.string().uuid(),
  supportedFeatureScopes: z.array(z.literal(E2E_FEATURE_PROCESS_RESPONSE_SCOPE)).min(1).max(1),
  state: z.enum(["READY", "PARKED", "UNAVAILABLE"]), qualifiedAt: timestamp, expiresAt: timestamp,
}).strict().superRefine((record, context) => {
  if (createHash("sha256").update(canonicalJson(record.binding)).digest("hex") !== record.bindingDigest) {
    context.addIssue({ code: "custom", path: ["bindingDigest"], message: "feature verifier binding digest must identify its exact binding" });
  }
  if (createHash("sha256").update(canonicalJson(record.runnerEnvironment)).digest("hex") !== record.runnerEnvironmentDigest) {
    context.addIssue({ code: "custom", path: ["runnerEnvironmentDigest"], message: "feature verifier environment digest must identify its exact environment" });
  }
  if (createHash("sha256").update(canonicalJson(record.runnerToolchain)).digest("hex") !== record.runnerToolchainDigest) {
    context.addIssue({ code: "custom", path: ["runnerToolchainDigest"], message: "feature verifier toolchain digest must identify its exact Node executable" });
  }
  if (Date.parse(record.qualifiedAt) >= Date.parse(record.expiresAt)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "feature verifier expiry must follow qualification" });
});
export type E2EFeatureVerifierRecord = z.infer<typeof E2EFeatureVerifierRecordSchema>;
export const E2EFeatureVerifierCatalogRecordSchema = z.union([E2EFeatureVerifierRecordSchema, E2ERegisteredRuntimeSchema]);
export type E2EFeatureVerifierCatalogRecord = E2EFeatureVerifierRecord | E2ERegisteredRuntime;

export function e2eFeatureVerifierKey(runtimeCatalogId: string, profileId: string): { pk: string; sk: string } {
  return { pk: `E2E_FEATURE_VERIFIER#${runtimeCatalogId}`, sk: `PROFILE#${profileId}` };
}

/** Requires an exact, current, separately qualified portable feature runtime; never accepts setup-only records. */
export function admitE2EFeatureVerifier(
  recordInput: unknown,
  input: { runtimeCatalogId: string; profileId: string; binding: Ec2RuntimeBinding; scope: typeof E2E_FEATURE_PROCESS_RESPONSE_SCOPE; now: number },
): E2EFeatureVerifierRecord | undefined {
  // DynamoDB rows carry their storage key beside the strict domain record. Accept only
  // that exact envelope and cross-check it against the requested catalog/profile before
  // projecting the known storage keys away for domain validation.
  if (recordInput === null || typeof recordInput !== "object" || Array.isArray(recordInput)) return undefined;
  const row = recordInput as Record<string, unknown>;
  const key = e2eFeatureVerifierKey(input.runtimeCatalogId, input.profileId);
  const allowed = new Set(["pk", "sk", "schemaVersion", "entityType", "runtimeCatalogId", "catalogRevision", "profileId", "bindingDigest", "binding",
    "manifestDigest", "runnerEnvironmentDigest", "runnerEnvironment", "runnerToolchainDigest", "runnerToolchain", "endpoint", "generation",
    "transportCorrelationId", "supportedFeatureScopes", "state", "qualifiedAt", "expiresAt"]);
  if (Object.keys(row).some((name) => !allowed.has(name)) || row.pk !== key.pk || row.sk !== key.sk) return undefined;
  const { pk: _pk, sk: _sk, ...domainRecord } = row;
  void _pk;
  void _sk;
  const parsed = E2EFeatureVerifierRecordSchema.safeParse(domainRecord);
  if (!parsed.success) return undefined;
  const record = parsed.data;
  const bindingDigest = createHash("sha256").update(canonicalJson(Ec2RuntimeBindingSchema.parse(input.binding))).digest("hex");
  if (record.state !== "READY" || record.runtimeCatalogId !== input.runtimeCatalogId || record.profileId !== input.profileId
    || record.bindingDigest !== bindingDigest || canonicalJson(record.binding) !== canonicalJson(input.binding)
    || !record.supportedFeatureScopes.includes(input.scope) || Date.parse(record.qualifiedAt) > input.now || Date.parse(record.expiresAt) <= input.now) return undefined;
  return record;
}
