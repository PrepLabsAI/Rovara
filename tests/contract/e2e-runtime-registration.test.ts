import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@agentx/contracts";
import {
  E2ERuntimeProbeManifestSchema,
  E2ERuntimeCapabilityDescriptorSchema,
  E2ERegisteredRuntimeSchema,
  assertE2ERuntimeProbeManifestIdentity,
  e2eRuntimeCapabilityDigest,
  type E2ERuntimeCapabilityDescriptor,
} from "../../packages/contracts/src/index.js";
import {
  admitE2ERegisteredRuntime,
  e2eRegisteredRuntimeKey,
} from "../../packages/broker/src/aws/e2e-runtime-readiness.js";
import { E2EFeatureVerifierCatalogRecordSchema, E2EFeatureVerifierRecordSchema } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";

const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const binding = { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef" }], volumeSizeGiB: 32, volumeType: "gp3" as const };
const runnerEnvironment = { ci: true as const, trustNoticeShown: false as const, os: "linux 6.8.0", arch: "x64", runtime: "node v22.23.2" };
const runnerToolchain = { execPath: "/opt/node/bin/node", version: "v22.23.2" as const, platform: "linux", arch: "x64" };
const capabilities: E2ERuntimeCapabilityDescriptor = E2ERuntimeCapabilityDescriptorSchema.parse({
  schemaVersion: "e2e-runtime-capabilities/v1", profileId: "web-profile", kind: "web",
  host: { os: "linux", arch: "x64" }, engine: { name: "playwright", version: "1.0.0", spiVersion: 1 },
  runtimeManifestDigest: "a".repeat(64), supportedSteps: ["navigate"], supportedAssertions: ["visible"],
  evidenceScopes: ["runtime"], networkPolicyDigest: "b".repeat(64), browsers: ["chromium"],
});
const probeBase = {
  schemaVersion: "e2e-runtime-probe-manifest/v1" as const,
  profileId: capabilities.profileId,
  capabilityDigest: e2eRuntimeCapabilityDigest(capabilities),
  runtimeManifestDigest: capabilities.runtimeManifestDigest,
  suiteDigest: "c".repeat(64),
  fixtureRefs: [{ path: "fixtures/smoke.json", sha256: "d".repeat(64) }],
  positiveProbeIds: ["browser-opens"],
  negativeProbeIds: ["browser-blocked-network"],
};
function probeManifest(overrides: Record<string, unknown> = {}) {
  const base = { ...probeBase, ...overrides };
  return { ...base, manifestDigest: digest(base) };
}
const probe = probeManifest();
const registration = {
  schemaVersion: 2 as const, entityType: "E2E_FEATURE_VERIFIER" as const,
  runtimeCatalogId: "runtime-catalog", catalogRevision: 3, profileId: capabilities.profileId,
  generation: 4, binding, bindingDigest: digest(binding), endpoint: "http://10.0.0.8:8080",
  transportCorrelationId: "11111111-1111-4111-8111-111111111111", manifestDigest: capabilities.runtimeManifestDigest,
  runnerEnvironment, runnerEnvironmentDigest: digest(runnerEnvironment), runnerToolchain, runnerToolchainDigest: digest(runnerToolchain),
  capabilities, capabilityDigest: e2eRuntimeCapabilityDigest(capabilities), probeManifest: probe,
  qualificationEvidenceRef: { key: "runtime-evidence/qual-4.json", sha256: "e".repeat(64), byteLength: 128 },
  state: "READY" as const, qualifiedAt: "2026-10-13T12:00:00.000Z", expiresAt: "2026-10-13T13:00:00.000Z",
};
const now = Date.parse("2026-10-13T12:30:00.000Z");
const expected = { runtimeCatalogId: registration.runtimeCatalogId, profileId: registration.profileId, binding,
  capabilityDigest: registration.capabilityDigest, now };

describe("authenticated E2E runtime catalog projection", () => {
  it("hashes the canonical parsed descriptor independent of property insertion order", () => {
    expect(e2eRuntimeCapabilityDigest(capabilities)).toBe(e2eRuntimeCapabilityDigest({
      browsers: ["chromium"], networkPolicyDigest: "b".repeat(64), evidenceScopes: ["runtime"],
      supportedAssertions: ["visible"], supportedSteps: ["navigate"], runtimeManifestDigest: "a".repeat(64),
      engine: { spiVersion: 1, version: "1.0.0", name: "playwright" }, host: { arch: "x64", os: "linux" },
      kind: "web", profileId: "web-profile", schemaVersion: "e2e-runtime-capabilities/v1",
    }));
  });

  it("requires a canonical fixed probe manifest with positive and negative probes", () => {
    expect(E2ERuntimeProbeManifestSchema.parse(probe)).toEqual(probe);
    expect(E2ERuntimeProbeManifestSchema.safeParse(probeManifest({ positiveProbeIds: ["browser-opens"], negativeProbeIds: [] })).success).toBe(false);
    expect(E2ERuntimeProbeManifestSchema.safeParse(probeManifest({ fixtureRefs: [{ path: "../escape.json", sha256: "d".repeat(64) }] })).success).toBe(false);
    expect(E2ERuntimeProbeManifestSchema.safeParse({ ...probe, unrecognized: true }).success).toBe(false);
    expect(() => assertE2ERuntimeProbeManifestIdentity(probe, probeManifest({ suiteDigest: "f".repeat(64) }))).toThrow();
    expect(() => assertE2ERuntimeProbeManifestIdentity({ ...probe, suiteDigest: "f".repeat(64) }, probe)).toThrow();
  });

  it("cross-checks registration identities and admits only a ready current catalog row", () => {
    const parsed = E2ERegisteredRuntimeSchema.parse(registration);
    expect(parsed.manifestDigest).toBe(parsed.capabilities.runtimeManifestDigest);
    expect(parsed.manifestDigest).toBe(parsed.probeManifest.runtimeManifestDigest);
    expect(parsed.manifestDigest).not.toBe(parsed.probeManifest.manifestDigest);
    const key = e2eRegisteredRuntimeKey(parsed.runtimeCatalogId, parsed.profileId);
    expect(key).toEqual({ pk: "E2E_FEATURE_VERIFIER#runtime-catalog", sk: "PROFILE#web-profile" });
    const row = { ...key, ...parsed };
    expect(admitE2ERegisteredRuntime(row, expected)).toEqual(parsed);
    expect(admitE2ERegisteredRuntime({ ...row, pk: "E2E_FEATURE_VERIFIER#other" }, expected)).toBeUndefined();
    expect(admitE2ERegisteredRuntime({ ...row, sk: "PROFILE#other" }, expected)).toBeUndefined();
    expect(admitE2ERegisteredRuntime({ ...row, unrecognized: true }, expected)).toBeUndefined();
    expect(admitE2ERegisteredRuntime({ ...row, profileId: "other" }, expected)).toBeUndefined();
    expect(admitE2ERegisteredRuntime({ ...row, binding: { ...binding, volumeSizeGiB: 64 } }, expected)).toBeUndefined();
    expect(admitE2ERegisteredRuntime({ ...row, capabilityDigest: "f".repeat(64) }, expected)).toBeUndefined();
    expect(() => assertE2ERuntimeProbeManifestIdentity(probeManifest({ suiteDigest: "f".repeat(64) }), probe)).toThrow();
    const changedDriverManifest = probeManifest({ runtimeManifestDigest: "f".repeat(64) });
    expect(E2ERegisteredRuntimeSchema.safeParse({ ...registration, probeManifest: changedDriverManifest }).success).toBe(false);
    expect(admitE2ERegisteredRuntime({ ...row, qualifiedAt: "2026-10-13T12:31:00.000Z" }, expected)).toBeUndefined();
    expect(E2EFeatureVerifierCatalogRecordSchema.safeParse(parsed).success).toBe(true);
    expect(E2EFeatureVerifierCatalogRecordSchema.safeParse(E2EFeatureVerifierRecordSchema.parse({
      schemaVersion: 1, entityType: "E2E_FEATURE_VERIFIER", runtimeCatalogId: "legacy", catalogRevision: 1,
      profileId: "default-sandbox", bindingDigest: digest(binding), binding, manifestDigest: "a".repeat(64),
      runnerEnvironment: { ci: true, trustNoticeShown: false, os: "linux", arch: "arm64", runtime: "node v22.23.2" },
      runnerEnvironmentDigest: digest({ ci: true, trustNoticeShown: false, os: "linux", arch: "arm64", runtime: "node v22.23.2" }),
      runnerToolchain: { execPath: "/opt/node/bin/node", version: "v22.23.2", platform: "linux", arch: "arm64" },
      runnerToolchainDigest: digest({ execPath: "/opt/node/bin/node", version: "v22.23.2", platform: "linux", arch: "arm64" }),
      endpoint: "http://10.0.0.9:8080", generation: 1, transportCorrelationId: "22222222-2222-4222-8222-222222222222",
      supportedFeatureScopes: ["portable-process-response/v1"], state: "READY",
      qualifiedAt: "2026-10-13T12:00:00.000Z", expiresAt: "2026-10-13T13:00:00.000Z",
    })).success).toBe(true);
  });

  it("does not allow a descriptor or caller-selected capability digest to qualify a runtime", () => {
    expect(admitE2ERegisteredRuntime(null, expected)).toBeUndefined();
    expect(admitE2ERegisteredRuntime({ ...registration, state: "PARKED" }, expected)).toBeUndefined();
    expect(E2ERegisteredRuntimeSchema.safeParse({ ...registration, capabilityDigest: "f".repeat(64) }).success).toBe(false);
    expect(E2ERegisteredRuntimeSchema.safeParse({ ...registration, capabilities: { ...capabilities, profileId: "other" } }).success).toBe(false);
    expect(E2ERegisteredRuntimeSchema.safeParse({ ...registration, runnerToolchain: { ...runnerToolchain, arch: "arm64" } }).success).toBe(false);
    expect(E2ERegisteredRuntimeSchema.safeParse({ ...registration, endpoint: "http://user:pass@10.0.0.8:8080" }).success).toBe(false);
  });

  it("returns validation failures instead of throwing for malformed nested schemas and URLs", () => {
    const malformedCapabilities = { ...capabilities, supportedSteps: ["navigate", "navigate"] };
    expect(() => E2ERegisteredRuntimeSchema.safeParse({ ...registration, capabilities: malformedCapabilities })).not.toThrow();
    expect(E2ERegisteredRuntimeSchema.safeParse({ ...registration, capabilities: malformedCapabilities }).success).toBe(false);
    expect(() => E2ERegisteredRuntimeSchema.safeParse({ ...registration, endpoint: "not-a-url" })).not.toThrow();
    expect(E2ERegisteredRuntimeSchema.safeParse({ ...registration, endpoint: "not-a-url" }).success).toBe(false);

    const row = { ...e2eRegisteredRuntimeKey(registration.runtimeCatalogId, registration.profileId), ...registration, capabilities: malformedCapabilities };
    expect(() => admitE2ERegisteredRuntime(row, expected)).not.toThrow();
    expect(admitE2ERegisteredRuntime(row, expected)).toBeUndefined();
  });

  it("binds runner OS, architecture and Node runtime to the registered toolchain", () => {
    const mismatchedOs = { ...runnerEnvironment, os: "win32 Windows Server 2022" };
    expect(E2ERegisteredRuntimeSchema.safeParse({ ...registration, runnerEnvironment: mismatchedOs,
      runnerEnvironmentDigest: digest(mismatchedOs) }).success).toBe(false);
    const mismatchedRuntime = { ...runnerEnvironment, runtime: "node v1.0.0" };
    expect(E2ERegisteredRuntimeSchema.safeParse({ ...registration, runnerEnvironment: mismatchedRuntime,
      runnerEnvironmentDigest: digest(mismatchedRuntime) }).success).toBe(false);
    const windowsCapabilities = E2ERuntimeCapabilityDescriptorSchema.parse({ ...capabilities, host: { os: "win32", arch: "x64" } });
    const windowsProbe = probeManifest({ capabilityDigest: e2eRuntimeCapabilityDigest(windowsCapabilities) });
    const windowsEnvironment = { ...runnerEnvironment, os: "win32 Windows Server 2022" };
    const windowsToolchain = { ...runnerToolchain, platform: "win32" };
    expect(E2ERegisteredRuntimeSchema.safeParse({ ...registration,
      runnerEnvironment: windowsEnvironment, runnerEnvironmentDigest: digest(windowsEnvironment),
      runnerToolchain: windowsToolchain, runnerToolchainDigest: digest(windowsToolchain),
      capabilities: windowsCapabilities, capabilityDigest: e2eRuntimeCapabilityDigest(windowsCapabilities), probeManifest: windowsProbe,
    }).success).toBe(true);
  });
});
