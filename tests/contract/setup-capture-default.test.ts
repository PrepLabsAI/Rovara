import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { E2EPolicySchema, canonicalJson } from "@agentx/contracts";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { call } from "../support/slack-broker.js";
import { contractSnapshot } from "../support/e2e-application-plan-fixtures.js";

// Owner decision D3 as amended by Ruling CJ: a new setup proposal captures screenshots of failed cases and downloads, never video and never traces (traces are deferred past
// M1.3). A project whose setup was approved earlier keeps the policy it was approved with, and gets captures only after its setup is approved again: nothing here rewrites a
// stored project policy.
describe("the capture policy a new setup proposal carries", () => {
  const D3 = { screenshots: true, traces: false, video: false, downloads: true };
  const admin = { subject: "admin-subject", admin: true };
  const proposeAndStore = async () => {
    const harness = await createDeveloperTaskBroker({ brokerExtra: { projectSetupSource: { capture: vi.fn(async () => contractSnapshot) } } });
    const proposal = await call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-proposals", user: admin, body: { repositoryUrl: "https://github.com/example/demo.git", ref: "main" } });
    expect(proposal.status, JSON.stringify(proposal.body)).toBe(200);
    return { harness, proposal };
  };
  const approve = (harness: Awaited<ReturnType<typeof proposeAndStore>>["harness"], proposalRef: string, proposalSha256: string, decision = "approve") =>
    call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-approvals", user: admin, body: { projectName: "payments", proposalRef, proposalSha256, decision } });
  /** The proposal as an earlier release stored it: the same bytes, with the all-false capture policy it carried then, under its own digest. */
  const asEarlierRelease = (harness: Awaited<ReturnType<typeof proposeAndStore>>["harness"], proposalRef: string) => {
    const stored = JSON.parse(harness.s3.objects.get(proposalRef)!) as { policy: { capture: unknown } };
    stored.policy.capture = { screenshots: false, traces: false, video: false, downloads: false };
    const bytes = canonicalJson(stored);
    const sha = createHash("sha256").update(bytes, "utf8").digest("hex");
    const ref = `${proposalRef.slice(0, proposalRef.lastIndexOf("/") + 1)}${sha}.json`;
    harness.s3.objects.set(ref, bytes);
    return { ref, sha, ownerKey: proposalRef.split("/")[1]! };
  };

  it("is screenshots and downloads, without traces or video, as the setup route proposes, and the same policy the approval then holds the proposal to", async () => {
    const { harness, proposal } = await proposeAndStore();
    expect(E2EPolicySchema.parse(proposal.body.policy).capture).toEqual(D3);
    const approval = await approve(harness, String(proposal.body.proposalRef), String(proposal.body.proposalSha256));
    expect(approval.status, JSON.stringify(approval.body)).toBe(200);
  });

  it("tells the administrator to propose the setup again when the proposal was made before this default", async () => {
    const { harness, proposal } = await proposeAndStore();
    const old = asEarlierRelease(harness, String(proposal.body.proposalRef));
    const refused = await approve(harness, old.ref, old.sha);
    expect(refused.status).not.toBe(200);
    expect(JSON.stringify(refused.body)).toMatch(/propose the setup again/i);
    expect(JSON.stringify(refused.body)).not.toContain("fixed approved default\"");
  });

  it("still answers an idempotent retry of an approval that was already decided with duplicate: true, even for such an earlier proposal", async () => {
    const { harness, proposal } = await proposeAndStore();
    const old = asEarlierRelease(harness, String(proposal.body.proposalRef));
    harness.db.set({ pk: "PROJECT_SETUP#payments", sk: `PROPOSAL#${old.sha}`, entityType: "PROJECT_SETUP_APPROVAL", ownerKey: old.ownerKey, projectName: "payments", proposalRef: old.ref,
      proposalSha256: old.sha, decision: "approve" });
    const retry = await approve(harness, old.ref, old.sha);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body).toMatchObject({ decision: "approve", duplicate: true });
    // A different decision for the same earlier proposal is still refused as a conflict, not answered as a duplicate.
    const conflicting = await approve(harness, old.ref, old.sha, "decline");
    expect(conflicting.status).not.toBe(200);
  });
});
