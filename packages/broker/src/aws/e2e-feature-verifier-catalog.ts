import { createHash } from "node:crypto";
import {
  canonicalJson, Ec2RuntimeBindingSchema, ProjectSetupRunnerEnvironmentSchema, ProjectSetupRunnerToolchainSchema, type Ec2RuntimeBinding,
  E2ERegisteredRuntimeSchema, E2ERuntimeCapabilityDescriptorSchema, WEB_API_NETWORK_POLICY_DIGEST, WEB_API_RUNTIME_PROFILE_ID,
  e2eRuntimeCapabilityDigest, type E2ERegisteredRuntime, type E2ERuntimeCapabilityDescriptor, type WebApiRuntimeInstallProposal,
} from "@agentx/contracts";
import { ROVARA_HTTP_ENGINE_DESCRIPTOR } from "@agentx/verifier";
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

/** The pinned `@e2e-dev/web` engine the web runtime drives; a test keeps this equal to the verifier package's dependency. */
export const WEB_API_WEB_ENGINE = Object.freeze({ name: "web", version: "0.14.0", spiVersion: 1 as const });
const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

/**
 * What each kind of the qualified runtime actually implements, not what the engine could do: the web runtime executes navigate, fill,
 * click and choose-file and observes text, visibility and the downloaded CSV; the API runtime issues requests and judges status, JSON
 * and the one installed read-only state probe. Anything beyond that stays unavailable to planning.
 */
export function webApiRuntimeCapabilities(kind: "web" | "api", runtimeManifestDigest: string): E2ERuntimeCapabilityDescriptor {
  const common = { schemaVersion: "e2e-runtime-capabilities/v1", profileId: WEB_API_RUNTIME_PROFILE_ID, kind, host: { os: "linux", arch: "arm64" },
    runtimeManifestDigest, evidenceScopes: ["runtime"], networkPolicyDigest: WEB_API_NETWORK_POLICY_DIGEST,
    // The host serves an approved source-backed API fixture to the app as an in-network mock of its declared origin, and records every call no mock matched.
    mocks: ["source-backed-api-fixtures/v1"] };
  return E2ERuntimeCapabilityDescriptorSchema.parse(kind === "web"
    ? { ...common, engine: { ...WEB_API_WEB_ENGINE }, supportedSteps: ["navigate", "fill", "click", "choose-file"],
      supportedAssertions: ["text", "visible", "csv"], browsers: ["chromium"] }
    : { ...common, engine: { name: ROVARA_HTTP_ENGINE_DESCRIPTOR.name, version: ROVARA_HTTP_ENGINE_DESCRIPTOR.version, spiVersion: 1 },
      supportedSteps: ["request"], supportedAssertions: ["http-status", "json", "state"], protocols: ["http"] });
}

/**
 * The only writer of v2 catalog rows. It runs only on a proposal that already parsed as a READY web/API qualification (its schema
 * re-judges the recorded probe evidence), and writes one row per target kind from that single qualification.
 */
export function e2eWebApiRuntimeRecords(input: {
  proposal: WebApiRuntimeInstallProposal; revisions: Readonly<{ web: number; api: number }>; qualifiedAt: string;
  evidence: Readonly<{ key: string; sha256: string; byteLength: number }>;
}): Record<"web" | "api", E2ERegisteredRuntime> {
  const { proposal } = input;
  const binding = Ec2RuntimeBindingSchema.parse(proposal.challenge.binding);
  const runnerEnvironment = ProjectSetupRunnerEnvironmentSchema.parse(proposal.runnerEnvironment);
  const runnerToolchain = ProjectSetupRunnerToolchainSchema.parse(proposal.runnerToolchain);
  const expiresAt = new Date(Math.min(Date.parse(proposal.challenge.expiresAt) + 30 * 24 * 60 * 60_000, Date.parse(input.qualifiedAt) + 7 * 24 * 60 * 60_000)).toISOString();
  const rowFor = (kind: "web" | "api"): E2ERegisteredRuntime => {
    const capabilities = webApiRuntimeCapabilities(kind, proposal.manifest.sha256);
    const capabilityDigest = e2eRuntimeCapabilityDigest(capabilities);
    const probes = proposal.probes.filter((probe) => probe.kind === kind || probe.kind === "build");
    const probeBody = { schemaVersion: "e2e-runtime-probe-manifest/v1" as const, profileId: WEB_API_RUNTIME_PROFILE_ID, capabilityDigest,
      runtimeManifestDigest: proposal.manifest.sha256, suiteDigest: sha(probes.map((probe) => ({ probeId: probe.probeId, assetDigest: probe.assetDigest }))),
      fixtureRefs: probes.map((probe) => ({ path: `application-runtime-v1/probes/${probe.probeId}.json`, sha256: probe.assetDigest })),
      positiveProbeIds: probes.filter((probe) => probe.expectedOutcome === "PASS").map((probe) => probe.probeId),
      negativeProbeIds: probes.filter((probe) => probe.expectedOutcome === "EXPECTED_FAILURE").map((probe) => probe.probeId) };
    return E2ERegisteredRuntimeSchema.parse({ schemaVersion: 2, entityType: "E2E_FEATURE_VERIFIER", runtimeCatalogId: proposal.challenge.featureCatalogId,
      profileId: WEB_API_RUNTIME_PROFILE_ID, catalogRevision: input.revisions[kind], generation: proposal.challenge.generation, binding, bindingDigest: sha(binding),
      endpoint: proposal.challenge.endpoint, transportCorrelationId: proposal.challenge.transportCorrelationId, manifestDigest: proposal.manifest.sha256,
      runnerEnvironment, runnerEnvironmentDigest: sha(runnerEnvironment), runnerToolchain, runnerToolchainDigest: sha(runnerToolchain),
      state: "READY", qualifiedAt: input.qualifiedAt, expiresAt, capabilities, capabilityDigest,
      probeManifest: { ...probeBody, manifestDigest: sha(probeBody) }, qualificationEvidenceRef: { ...input.evidence } });
  };
  return { web: rowFor("web"), api: rowFor("api") };
}
