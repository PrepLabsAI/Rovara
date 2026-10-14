import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@agentx/contracts";
import { admitE2EFeatureVerifier, e2eFeatureVerifierKey, E2EFeatureVerifierRecordSchema } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";

const binding = { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef" }], volumeSizeGiB: 32, volumeType: "gp3" as const };
const runnerEnvironment = { ci: true, trustNoticeShown: false, os: "linux 6.8.0", arch: "arm64", runtime: "node v22.23.2" };
const runnerToolchain = { execPath: process.execPath, version: "v22.23.2" as const, platform: process.platform, arch: process.arch };
const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const record = {
  schemaVersion: 1 as const, entityType: "E2E_FEATURE_VERIFIER" as const, runtimeCatalogId: "default-verifier", catalogRevision: 3,
  profileId: "default-sandbox", bindingDigest: sha(binding), binding, manifestDigest: "a".repeat(64),
  runnerEnvironment, runnerEnvironmentDigest: sha(runnerEnvironment), runnerToolchain, runnerToolchainDigest: sha(runnerToolchain),
  endpoint: "http://10.0.0.8:8080", generation: 7, transportCorrelationId: "11111111-1111-4111-8111-111111111111",
  supportedFeatureScopes: ["portable-process-response/v1"] as const, state: "READY" as const,
  qualifiedAt: "2026-10-13T12:00:00.000Z", expiresAt: "2026-10-13T13:00:00.000Z",
};

describe("separate configured feature verifier authority", () => {
  it("admits only the exact current default profile, catalog, binding, and process-response scope", () => {
    const parsed = E2EFeatureVerifierRecordSchema.parse(record);
    const stored = { ...e2eFeatureVerifierKey(parsed.runtimeCatalogId, parsed.profileId), ...parsed };
    expect(e2eFeatureVerifierKey(parsed.runtimeCatalogId, parsed.profileId)).toEqual({
      pk: "E2E_FEATURE_VERIFIER#default-verifier", sk: "PROFILE#default-sandbox",
    });
    expect(admitE2EFeatureVerifier(stored, { runtimeCatalogId: "default-verifier", profileId: "default-sandbox", binding,
      scope: "portable-process-response/v1", now: Date.parse("2026-10-13T12:30:00.000Z") })).toMatchObject({ generation: 7, endpoint: "http://10.0.0.8:8080" });
  });

  it("reads the exact Dynamo key envelope while rejecting foreign keys and unknown stored metadata", () => {
    const parsed = E2EFeatureVerifierRecordSchema.parse(record);
    const key = e2eFeatureVerifierKey(parsed.runtimeCatalogId, parsed.profileId);
    const row = { ...key, ...parsed };
    expect(admitE2EFeatureVerifier(row, { runtimeCatalogId: parsed.runtimeCatalogId, profileId: parsed.profileId, binding,
      scope: "portable-process-response/v1", now: Date.parse("2026-10-13T12:30:00.000Z") })).toMatchObject({ generation: 7 });
    expect(admitE2EFeatureVerifier({ ...row, sk: "PROFILE#foreign" }, { runtimeCatalogId: parsed.runtimeCatalogId, profileId: parsed.profileId, binding,
      scope: "portable-process-response/v1", now: Date.parse("2026-10-13T12:30:00.000Z") })).toBeUndefined();
    expect(admitE2EFeatureVerifier({ ...row, entityType: "OTHER" }, { runtimeCatalogId: parsed.runtimeCatalogId, profileId: parsed.profileId, binding,
      scope: "portable-process-response/v1", now: Date.parse("2026-10-13T12:30:00.000Z") })).toBeUndefined();
  });

  it("rejects setup-only records, wrong scopes, stale records, and same-generation catalog changes", () => {
    const parsed = E2EFeatureVerifierRecordSchema.parse(record);
    const stored = { ...e2eFeatureVerifierKey(parsed.runtimeCatalogId, parsed.profileId), ...parsed };
    expect(admitE2EFeatureVerifier(stored, { runtimeCatalogId: parsed.runtimeCatalogId, profileId: "other-profile", binding,
      scope: "portable-process-response/v1", now: Date.parse("2026-10-13T12:30:00.000Z") })).toBeUndefined();
    expect(admitE2EFeatureVerifier({ ...stored, supportedFeatureScopes: ["source-interface"] },
      { runtimeCatalogId: parsed.runtimeCatalogId, profileId: parsed.profileId, binding,
        scope: "portable-process-response/v1", now: Date.parse("2026-10-13T12:30:00.000Z") })).toBeUndefined();
    expect(admitE2EFeatureVerifier({ ...stored, expiresAt: "2026-10-13T12:20:00.000Z" }, { runtimeCatalogId: parsed.runtimeCatalogId,
      profileId: parsed.profileId, binding, scope: "portable-process-response/v1", now: Date.parse("2026-10-13T12:30:00.000Z") })).toBeUndefined();
    expect(E2EFeatureVerifierRecordSchema.safeParse({ ...parsed, supportedFeatureScopes: ["source-interface"] }).success).toBe(false);
    expect(E2EFeatureVerifierRecordSchema.safeParse({ ...parsed, binding: { ...binding, volumeSizeGiB: 64 } }).success).toBe(false);
  });
});
