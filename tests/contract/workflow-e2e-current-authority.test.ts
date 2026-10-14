import { describe, expect, it } from "vitest";
import { workflowE2ECurrentAuthorityMatches } from "../../packages/broker/src/aws/workflow-e2e-current-authority.js";

const authority = () => ({
  admission: { candidateDigest: "a".repeat(64), intent: { scenario: "approved" }, policy: { revision: 4 },
    runtime: { state: "READY", qualifiedAt: "2026-10-13T12:00:00Z", expiresAt: "2026-10-13T13:00:00Z", binding: { subnets: ["a", "b"] } },
    portableApprovalBinding: { digest: "b".repeat(64) }, creatorAuthority: { kind: "direct-membership", grantId: "grant-1" },
    approval: { artifactId: "artifact-1", artifactDigest: "c".repeat(64), graphDigest: "d".repeat(64), runId: "run-1", workflowRevision: 7, actorId: "owner-1" } },
  current: { candidateDigest: "a".repeat(64), intent: { scenario: "approved" }, policy: { revision: 4 },
    runtime: { state: "READY", qualifiedAt: "2026-10-13T12:00:00Z", expiresAt: "2026-10-13T13:00:00Z", binding: { subnets: ["a", "b"] } },
    portableApprovalBinding: { digest: "b".repeat(64) }, creatorAuthority: { kind: "direct-membership", grantId: "grant-1" },
    approval: { artifactId: "artifact-1", artifactDigest: "c".repeat(64), graphDigest: "d".repeat(64), runId: "run-1", workflowRevision: 7, actorId: "owner-1" },
    approvedDecision: true, creatorHasProjectAccess: true, now: Date.parse("2026-10-13T12:30:00Z") },
});

describe("current workflow E2E authority", () => {
  it("accepts only the exact still-current approved runtime snapshot", () => {
    expect(workflowE2ECurrentAuthorityMatches(authority())).toBe(true);
  });

  it("retains a locally bound channel-access proof as a distinct creator authority", () => {
    const input = authority();
    const channelProof = { kind: "channel-access", developerId: "creator-1", project: "orders", teamId: "T123",
      channelIds: ["C123"], bindings: [{ channelId: "C123", updatedAt: "2026-10-13T12:00:00.000Z" }] };
    (input.admission as { creatorAuthority: unknown }).creatorAuthority = channelProof;
    (input.current as { creatorAuthority: unknown }).creatorAuthority = structuredClone(channelProof);
    expect(workflowE2ECurrentAuthorityMatches(input)).toBe(true);
    ((((input.current as unknown as { creatorAuthority: typeof channelProof }).creatorAuthority).bindings[0]!).updatedAt) = "2026-10-13T12:01:00.000Z";
    expect(workflowE2ECurrentAuthorityMatches(input)).toBe(false);
  });

  it.each([
    ["removed canonical approval", (input: ReturnType<typeof authority>) => { input.current.approvedDecision = false; }],
    ["changed runtime binding", (input: ReturnType<typeof authority>) => { (input.current.runtime as { binding: { subnets: string[] } }).binding.subnets.reverse(); }],
    ["expired runtime", (input: ReturnType<typeof authority>) => { input.current.now = Date.parse("2026-10-13T13:00:00Z"); }],
    ["removed creator authority", (input: ReturnType<typeof authority>) => { input.current.creatorHasProjectAccess = false; }],
    ["revoked and regranted creator membership", (input: ReturnType<typeof authority>) => { input.current.creatorAuthority = { kind: "direct-membership", grantId: "grant-2" }; }],
  ])("returns false for %s", (_label, mutate) => {
    const input = authority();
    mutate(input);
    expect(workflowE2ECurrentAuthorityMatches(input)).toBe(false);
  });
});
