import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, E2ETargetSchema, type E2ERuntimeCapabilityDescriptor, type E2ERuntimeReadinessInput } from "@agentx/contracts";
import { E2ERuntimeCapabilityDescriptorSchema, e2eRuntimeCapabilityDigest } from "../../packages/contracts/src/index.js";
import { e2eRegisteredRuntimeKey, projectE2ERuntimeReadiness } from "../../packages/broker/src/aws/e2e-runtime-readiness.js";

const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const binding = { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef" }], volumeSizeGiB: 32, volumeType: "gp3" as const };
const capabilities: E2ERuntimeCapabilityDescriptor = E2ERuntimeCapabilityDescriptorSchema.parse({
  schemaVersion: "e2e-runtime-capabilities/v1", profileId: "web-profile", kind: "web",
  host: { os: "linux", arch: "x64" }, engine: { name: "playwright", version: "1.0.0", spiVersion: 1 },
  runtimeManifestDigest: "a".repeat(64), supportedSteps: ["navigate"], supportedAssertions: ["visible"],
  evidenceScopes: ["runtime"], networkPolicyDigest: "b".repeat(64), browsers: ["chromium"],
});
const probeBase = {
  schemaVersion: "e2e-runtime-probe-manifest/v1", profileId: "web-profile", capabilityDigest: e2eRuntimeCapabilityDigest(capabilities),
  runtimeManifestDigest: capabilities.runtimeManifestDigest, suiteDigest: "c".repeat(64),
  fixtureRefs: [{ path: "fixtures/smoke.json", sha256: "d".repeat(64) }], positiveProbeIds: ["browser-opens"], negativeProbeIds: ["browser-blocked-network"],
};
const probe = { ...probeBase, manifestDigest: sha(probeBase) };
const environment = { ci: true, trustNoticeShown: false, os: "linux 6.8.0", arch: "x64", runtime: "node v22.23.2" };
const toolchain = { execPath: "/opt/node/bin/node", version: "v22.23.2", platform: "linux", arch: "x64" };
const registration = {
  schemaVersion: 2, entityType: "E2E_FEATURE_VERIFIER", runtimeCatalogId: "runtime-catalog", catalogRevision: 3,
  profileId: "web-profile", generation: 4, binding, bindingDigest: sha(binding), endpoint: "http://10.0.0.8:8080",
  transportCorrelationId: "11111111-1111-4111-8111-111111111111", manifestDigest: probe.manifestDigest,
  runnerEnvironment: environment, runnerEnvironmentDigest: sha(environment), runnerToolchain: toolchain, runnerToolchainDigest: sha(toolchain),
  capabilities, capabilityDigest: e2eRuntimeCapabilityDigest(capabilities), probeManifest: probe,
  qualificationEvidenceRef: { key: "runtime-evidence/qual-4.json", sha256: "e".repeat(64), byteLength: 128 },
  state: "READY", qualifiedAt: "2026-10-13T12:00:00.000Z", expiresAt: "2026-10-13T13:00:00.000Z",
};
const key = e2eRegisteredRuntimeKey(registration.runtimeCatalogId, registration.profileId);
const target = E2ETargetSchema.parse({ targetId: "web-app", applicationId: "app", runtimeProfileId: "web-profile", accountProfileId: "synthetic",
  kind: "web", browser: "chromium", viewport: { width: 1280, height: 720 } });
type ReadinessOverrides = Partial<Omit<Parameters<typeof projectE2ERuntimeReadiness>[0], "record" | "expected" | "target">>;
const input = (record: unknown = { ...key, ...registration }, overrides: ReadinessOverrides = {}): Parameters<typeof projectE2ERuntimeReadiness>[0] => ({
  record,
  expected: { runtimeCatalogId: registration.runtimeCatalogId, profileId: registration.profileId, binding,
    capabilityDigest: registration.capabilityDigest, now: Date.parse("2026-10-13T12:30:00.000Z") },
  target, requiredSteps: ["navigate"] as E2ERuntimeReadinessInput["requiredSteps"],
  requiredAssertions: ["visible"] as E2ERuntimeReadinessInput["requiredAssertions"], minimumEvidence: "runtime" as const,
  installationEnabled: true, activationEnabled: true,
  connection: "connected",
  approval: "approved", ...overrides,
});

describe("registered E2E runtime readiness", () => {
  it("projects only an exact qualified catalog row through capability readiness", () => {
    expect(projectE2ERuntimeReadiness(input())).toMatchObject({ targetId: "web-app", profileId: "web-profile", status: "READY" });
    expect(projectE2ERuntimeReadiness(input({ ...key, ...registration, capabilityDigest: "f".repeat(64) }))).toMatchObject({ status: "INCOMPATIBLE" });
    expect(projectE2ERuntimeReadiness(input({ ...key, ...registration, pk: "E2E_FEATURE_VERIFIER#foreign" }))).toMatchObject({ status: "INCOMPATIBLE" });
  });

  it("preserves missing, expired, unqualified and access readiness states", () => {
    expect(projectE2ERuntimeReadiness(input(null))).toMatchObject({ status: "MISSING" });
    expect(projectE2ERuntimeReadiness(input({ ...key, ...registration, expiresAt: "2026-10-13T12:20:00.000Z" }))).toMatchObject({ status: "EXPIRED" });
    expect(projectE2ERuntimeReadiness(input({ ...key, ...registration, state: "PARKED" }))).toMatchObject({ status: "UNQUALIFIED" });
    expect(projectE2ERuntimeReadiness(input(null, { connection: "unconnected" }))).toMatchObject({ status: "MISSING" });
    expect(projectE2ERuntimeReadiness(input(null, { activationEnabled: false }))).toMatchObject({ status: "DISABLED" });
  });

  it("fails closed for malformed qualification clocks and incompatible capabilities", () => {
    expect(projectE2ERuntimeReadiness(input({ ...key, ...registration, qualifiedAt: "2029-02-29T12:00:00.000Z" }))).toMatchObject({ status: "INCOMPATIBLE" });
    expect(projectE2ERuntimeReadiness(input({ ...key, ...registration, qualifiedAt: "2026-10-13T12:31:00.000Z" }))).toMatchObject({ status: "UNQUALIFIED" });
    expect(projectE2ERuntimeReadiness(input({ ...key, ...registration, capabilities: { ...capabilities, host: { os: "win32", arch: "x64" } } }))).toMatchObject({ status: "INCOMPATIBLE" });
    expect(projectE2ERuntimeReadiness(input({ ...key, ...registration }, { requiredSteps: ["launch-app"] }))).toMatchObject({ status: "INCOMPATIBLE" });
  });
});
