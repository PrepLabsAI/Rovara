import { describe, expect, it } from "vitest";
import { projectSetupTerminalAuthorityChecks } from "../../packages/broker/src/aws/project-setup-terminal-conditions.js";

const checksFor = (companyId: string | undefined) => projectSetupTerminalAuthorityChecks("state", {
      setupExecutionId: "00000000-0000-4000-8000-000000000002",
      ownerKey: "OWNER#1", projectName: "orders", projectRevision: 3, runtimeCatalogId: "catalog-1", runtimeCatalogRevision: 4,
      bindingDigest: "a".repeat(64), runtimeGeneration: 9, transportCorrelationId: "00000000-0000-4000-8000-000000000001",
      proposalRef: "project-setup-proposals/OWNER#1/" + "e".repeat(64) + ".json", proposalSha256: "e".repeat(64),
      candidateDigest: "f".repeat(64), policyDigest: "1".repeat(64), approvalRevision: 1,
    }, {
      schemaVersion: 1, entityType: "PROJECT_SETUP_RUNTIME", runtimeCatalogId: "catalog-1", catalogRevision: 4,
      bindingDigest: "a".repeat(64), binding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-12345678", subnets: [
        { availabilityZone: "us-east-1a", subnetId: "subnet-12345678" }, { availabilityZone: "us-east-1b", subnetId: "subnet-87654321" },
      ], volumeSizeGiB: 20, volumeType: "gp3" },
      manifestDigest: "b".repeat(64), runnerEnvironmentDigest: "c".repeat(64), runnerEnvironment: { ci: true, trustNoticeShown: false, os: "Linux", arch: "arm64", runtime: "Node.js 22" },
      runnerToolchainDigest: "d".repeat(64), runnerToolchain: { execPath: "/usr/bin/node", version: "v22.23.2", platform: "linux", arch: "arm64" },
      endpoint: "https://verifier.example.test", generation: 9, transportCorrelationId: "00000000-0000-4000-8000-000000000001",
      supportedSetupScopes: ["source-interface"], state: "READY", qualifiedAt: "2026-10-13T10:00:00.000Z", expiresAt: "2026-10-13T11:00:00.000Z",
    }, { setupExecutionId: "00000000-0000-4000-8000-000000000002", subjectId: "00000000-0000-4000-8000-000000000003",
      generation: 9, transportCorrelationId: "00000000-0000-4000-8000-000000000001", bindingDigest: "a".repeat(64), approvalRevision: 1 }, companyId);

describe("project setup terminal authority transaction checks", () => {
  it("DEC 254zzz80: a named company's project checks the owner's grant in the company's own partition; the built-in company keeps the legacy key", () => {
    expect(checksFor("org_aaaaaaaaaaaaaaaaaaaa")[0]?.ConditionCheck.Key).toEqual({ pk: "ORG#org_aaaaaaaaaaaaaaaaaaaa#MEMBER#OWNER#1", sk: "PROJECT#orders" });
    expect(checksFor("org_00000000000000000000")[0]?.ConditionCheck.Key).toEqual({ pk: "MEMBER#OWNER#1", sk: "PROJECT#orders" });
  });

});
