import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@agentx/contracts";
import { admitProjectSetupRuntime, projectSetupRuntimeKey, ProjectSetupRuntimeRecordSchema } from "../../packages/broker/src/aws/project-setup-runtime-catalog.js";

const binding = {
  deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef" }], volumeSizeGiB: 32, volumeType: "gp3" as const,
};
const digest = createHash("sha256").update(canonicalJson(binding)).digest("hex");
const runnerEnvironment = { ci: true, trustNoticeShown: false, os: "darwin 24.0.0", arch: "arm64", runtime: "node v22.23.2" };
const runnerEnvironmentDigest = createHash("sha256").update(canonicalJson(runnerEnvironment)).digest("hex");
const runnerToolchain = { execPath: process.execPath, version: "v22.23.2" as const, platform: process.platform, arch: process.arch };
const runnerToolchainDigest = createHash("sha256").update(canonicalJson(runnerToolchain)).digest("hex");
const record = {
  schemaVersion: 1 as const, entityType: "PROJECT_SETUP_RUNTIME" as const, runtimeCatalogId: "default-verifier", catalogRevision: 3,
  bindingDigest: digest, binding, manifestDigest: "a".repeat(64), endpoint: "http://10.0.0.8:8080", generation: 7,
  runnerEnvironment, runnerEnvironmentDigest,
  runnerToolchain, runnerToolchainDigest,
  transportCorrelationId: "11111111-1111-4111-8111-111111111111",
  supportedSetupScopes: ["source-interface"] as const, state: "READY" as const,
  qualifiedAt: "2026-10-13T12:00:00.000Z", expiresAt: "2026-10-13T13:00:00.000Z",
};

describe("server configured project setup runtime registry", () => {
  it("admits only a fresh ready record for the exact approved binding and catalog", () => {
    const parsed = ProjectSetupRuntimeRecordSchema.parse(record);
    expect(projectSetupRuntimeKey(parsed.runtimeCatalogId, parsed.bindingDigest)).toEqual({
      pk: `PROJECT_SETUP_RUNTIME#${parsed.runtimeCatalogId}`, sk: `BINDING#${parsed.bindingDigest}`,
    });
    expect(admitProjectSetupRuntime(parsed, { runtimeCatalogId: "default-verifier", binding, scope: "source-interface", now: Date.parse("2026-10-13T12:30:00.000Z") })).toMatchObject({ generation: 7, endpoint: "http://10.0.0.8:8080" });
  });

  it("fails closed for stale, mismatched, unqualified, or unsupported records", () => {
    const parsed = ProjectSetupRuntimeRecordSchema.parse(record);
    expect(admitProjectSetupRuntime(parsed, { runtimeCatalogId: "default-verifier", binding, scope: "source-interface", now: Date.parse("2026-10-13T13:00:00.000Z") })).toBeUndefined();
    expect(admitProjectSetupRuntime(parsed, { runtimeCatalogId: "other", binding, scope: "source-interface", now: Date.parse("2026-10-13T12:30:00.000Z") })).toBeUndefined();
    expect(admitProjectSetupRuntime({ ...parsed, state: "PARKED" }, { runtimeCatalogId: parsed.runtimeCatalogId, binding, scope: "source-interface", now: Date.parse("2026-10-13T12:30:00.000Z") })).toBeUndefined();
    expect(ProjectSetupRuntimeRecordSchema.safeParse({ ...parsed, runnerEnvironment: { ...parsed.runnerEnvironment, runtime: "node v20.0.0" } }).success).toBe(false);
    expect(ProjectSetupRuntimeRecordSchema.safeParse({ ...parsed, runnerToolchain: { ...parsed.runnerToolchain, execPath: "/tmp/other-node" } }).success).toBe(false);
    expect(admitProjectSetupRuntime(parsed, { runtimeCatalogId: parsed.runtimeCatalogId, binding, scope: "feature-execution", now: Date.parse("2026-10-13T12:30:00.000Z") })).toBeUndefined();
  });
});
