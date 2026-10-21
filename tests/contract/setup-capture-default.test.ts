import { describe, expect, it, vi } from "vitest";
import { E2EPolicySchema } from "@agentx/contracts";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { call } from "../support/slack-broker.js";
import { contractSnapshot } from "../support/e2e-application-plan-fixtures.js";

// Owner decision D3: a new setup proposal captures screenshots and traces of failed cases, and downloads, never video. A project whose setup was approved earlier keeps the
// policy it was approved with: the stored project policy is read as written and nothing here rewrites it.
describe("the capture policy a new setup proposal carries", () => {
  const D3 = { screenshots: true, traces: true, video: false, downloads: true };
  const admin = { subject: "admin-subject", admin: true };

  it("is screenshots, traces and downloads without video, as the setup route proposes, and the same policy the approval then holds the proposal to", async () => {
    const harness = await createDeveloperTaskBroker({ brokerExtra: { projectSetupSource: { capture: vi.fn(async () => contractSnapshot) } } });
    const proposal = await call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-proposals", user: admin, body: { repositoryUrl: "https://github.com/example/demo.git", ref: "main" } });
    expect(proposal.status, JSON.stringify(proposal.body)).toBe(200);
    expect(E2EPolicySchema.parse(proposal.body.policy).capture).toEqual(D3);
    const approval = await call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-approvals", user: admin,
      body: { projectName: "payments", proposalRef: String(proposal.body.proposalRef), proposalSha256: String(proposal.body.proposalSha256), decision: "approve" } });
    expect(approval.status, JSON.stringify(approval.body)).toBe(200);
  });
});
