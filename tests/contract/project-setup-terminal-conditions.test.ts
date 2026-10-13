import { describe, expect, it } from "vitest";
import { projectSetupTerminalAuthorityChecks } from "../../packages/broker/src/aws/project-setup-terminal-conditions.js";
import { assertDynamoExpressionAttributes } from "../support/validating-document-client.js";

describe("project setup terminal authority transaction checks", () => {
  it("binds terminal writes to the admitted creator and exact current qualified runtime row", () => {
    const checks = projectSetupTerminalAuthorityChecks("state", {
      setupExecutionId: "00000000-0000-4000-8000-000000000002",
      ownerKey: "OWNER#1", projectName: "orders", projectRevision: 3, runtimeCatalogId: "catalog-1", runtimeCatalogRevision: 4,
      bindingDigest: "a".repeat(64), runtimeGeneration: 9, transportCorrelationId: "00000000-0000-4000-8000-000000000001",
      proposalRef: "project-setup-proposals/OWNER#1/" + "e".repeat(64) + ".json", proposalSha256: "e".repeat(64),
      candidateDigest: "f".repeat(64), policyDigest: "1".repeat(64), approvalRevision: 1,
    }, {
      schemaVersion: 1, entityType: "PROJECT_SETUP_RUNTIME", runtimeCatalogId: "catalog-1", catalogRevision: 4,
      bindingDigest: "a".repeat(64), binding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-12345678", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-12345678" }], volumeSizeGiB: 20, volumeType: "gp3" },
      manifestDigest: "b".repeat(64), runnerEnvironmentDigest: "c".repeat(64), runnerEnvironment: { ci: true, trustNoticeShown: false, os: "Linux", arch: "arm64", runtime: "Node.js 22" },
      runnerToolchainDigest: "d".repeat(64), runnerToolchain: { execPath: "/usr/bin/node", version: "v22.23.2", platform: "linux", arch: "arm64" },
      endpoint: "https://verifier.example.test", generation: 9, transportCorrelationId: "00000000-0000-4000-8000-000000000001",
      supportedSetupScopes: ["source-interface"], state: "READY", qualifiedAt: "2026-10-13T10:00:00.000Z", expiresAt: "2026-10-13T11:00:00.000Z",
    }, { setupExecutionId: "00000000-0000-4000-8000-000000000002", subjectId: "00000000-0000-4000-8000-000000000003",
      generation: 9, transportCorrelationId: "00000000-0000-4000-8000-000000000001", bindingDigest: "a".repeat(64), approvalRevision: 1 });

    expect(checks).toHaveLength(5);
    for (const check of checks) assertDynamoExpressionAttributes(check.ConditionCheck);
    const value = (index: number, name: string): unknown =>
      (checks[index]?.ConditionCheck.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[name];
    const membership = checks[0]?.ConditionCheck;
    expect(membership?.Key).toEqual({ pk: "MEMBER#OWNER#1", sk: "PROJECT#orders" });
    expect(membership?.ConditionExpression).toContain("#role = :administrator");
    expect(value(0, ":ownerKey")).toBe("OWNER#1");
    const project = checks[1]?.ConditionCheck;
    expect(project?.Key).toEqual({ pk: "PROJECT#orders", sk: "REV#000000000003" });
    expect(project?.ConditionExpression).toContain("setupApproval.proposalSha256 = :proposalSha");
    expect(value(1, ":registeredBy")).toBe("OWNER#1");
    expect(value(1, ":projectSubnet0")).toEqual({ availabilityZone: "us-east-1a", subnetId: "subnet-12345678" });
    const approval = checks[2]?.ConditionCheck;
    expect(approval?.Key).toEqual({ pk: "PROJECT_SETUP#orders", sk: `PROPOSAL#${"e".repeat(64)}` });
    expect(approval?.ConditionExpression).toContain("decision = :approve AND policyDigest = :policyDigest");
    expect(value(2, ":policyDigest")).toBe("1".repeat(64));
    const session = checks[3]?.ConditionCheck;
    expect(session?.Key).toEqual({ pk: "PROJECT_SETUP#00000000-0000-4000-8000-000000000002", sk: "SESSION" });
    expect(session?.ConditionExpression).toContain("#state = :ready AND generation = :generation");
    expect(value(3, ":correlation")).toBe("00000000-0000-4000-8000-000000000001");
    const runtime = checks[4]?.ConditionCheck;
    expect(runtime?.Key).toEqual({ pk: "PROJECT_SETUP_RUNTIME#catalog-1", sk: `BINDING#${"a".repeat(64)}` });
    expect(runtime?.ConditionExpression).toContain("catalogRevision = :catalogRevision AND bindingDigest = :bindingDigest");
    expect(value(4, ":qualifiedAt")).toBe("2026-10-13T10:00:00.000Z");
    expect(value(4, ":expiresAt")).toBe("2026-10-13T11:00:00.000Z");
    expect(value(4, ":launchTemplateId")).toBe("lt-12345678");
    expect(value(4, ":execPath")).toBe("/usr/bin/node");
    expect(value(4, ":subnet0")).toEqual({ availabilityZone: "us-east-1a", subnetId: "subnet-12345678" });
  });
});
