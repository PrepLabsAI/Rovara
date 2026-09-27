// FR-017 and FR-022: before agentx init creates anything, it shows every stack, role, secret, app
// and setting it will create, and an estimated monthly cost at a stated usage, then asks. No test
// here reaches AWS, GitHub or Slack.
import { describe, expect, it } from "vitest";
import { confirmInstallPlan, estimateMonthlyCost, installPlanText } from "../../packages/cli/src/init/plan.js";
import { sampleAnswers, scriptedPrompter } from "../support/init-fakes.js";

describe("cost estimate", () => {
  it("adds the fixed infrastructure and the default models at the stated usage", () => {
    const estimate = estimateMonthlyCost(sampleAnswers().models);
    expect(estimate.lines.map((line) => [line.item, line.usd])).toEqual([
      ["Two NAT gateways", 65.7],
      ["Slack service (Fargate, 0.5 vCPU, 1 GB, arm64)", 14.42],
      ["Worker instances (m6g.medium)", 2.31],
      ["Workspace volumes", 16],
      ["API Gateway, Lambda, DynamoDB, SQS, Secrets Manager, KMS and CloudWatch", 10],
      ["Orchestrator model (us.anthropic.claude-sonnet-4-6)", 25],
      ["Classifier model (amazon.nova-lite-v1:0)", 0.15],
      ["Worker model (amazon.nova-pro-v1:0)", 19.2],
    ]);
    expect(estimate.totalUsd).toBe(152.78);
    expect(estimate.unpriced).toEqual([]);
  });

  it("prices GLM 4.7 lower, and names a model it has no price for instead of guessing", () => {
    expect(estimateMonthlyCost({ ...sampleAnswers().models, orchestrator: "zai.glm-4.7" }).totalUsd).toBe(134.78);
    const custom = estimateMonthlyCost({ ...sampleAnswers().models, worker: "us.amazon.nova-premier-v1:0" });
    expect(custom.unpriced).toEqual(["us.amazon.nova-premier-v1:0"]);
    expect(custom.lines.find((line) => line.item.startsWith("Worker model"))?.usd).toBeUndefined();
    expect(custom.totalUsd).toBe(133.58);
  });
});

describe("install plan", () => {
  it("lists every stack, role, secret, app and setting it will create, and the cost", () => {
    const answers = sampleAnswers();
    const text = installPlanText(answers, estimateMonthlyCost(answers.models), []);
    for (const expected of [
      "AgentX will create environment staging in account 123456789012 (us-east-1) with the templates engine, release 1.2.3:",
      "agentx-staging-access, agentx-staging-foundation, agentx-staging-identity, agentx-staging-control-plane, agentx-staging-runtime, agentx-staging-slack",
      "IAM roles agentx-staging-cloudformation (CloudFormation deploys through it) and agentx-staging-operator (day-2 commands)",
      "the permission boundary agentx-staging-boundary, which every AgentX role carries; the stacks' own roles live under the IAM path /agentx/staging/",
      "Secrets agentx/staging/callback-signing-key, agentx/staging/github-app, agentx/staging/slack",
      "Settings under /agentx/staging/",
      "In GitHub: an app named \"AgentX acme staging\" owned by acme, with read and write access to contents, pull requests and issues, and read access to metadata. No webhook.",
      "In Slack: an app named \"AgentX\".",
      "Alerts: email to ops@example.com",
      "AgentX never answers itself or other bots. Mentions people post through other apps: accept (slack.appPostedMessages).",
      "Estimated monthly total: $152.78 at 1,000 turns, 100 worker sessions and 60 worker instance-hours a month",
      "Deleting the capacity provider deletes every workspace volume.",
    ]) expect(text).toContain(expected);
  });

  it("names a company boundary, a webhook's host only, no identity stack with your own OIDC, and the notes", () => {
    const answers = sampleAnswers({
      permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/CompanyBoundary",
      alert: { kind: "webhook", display: "https://events.pagerduty.com/...", secretName: "agentx/staging/alert-endpoint" },
      identity: { mode: "oidc", issuer: "https://id.example.com", audience: "a", clientId: "c", adminClaim: "groups", adminValues: ["x"] },
    });
    const text = installPlanText(answers, estimateMonthlyCost(answers.models), ["a note"]);
    expect(text).toContain("the permission boundary arn:aws:iam::123456789012:policy/CompanyBoundary");
    expect(text).toContain("Alerts: https://events.pagerduty.com/... (the full address is kept in agentx/staging/alert-endpoint)");
    expect(text).toContain("agentx/staging/alert-endpoint");
    expect(text).not.toContain("agentx-staging-identity");
    expect(text).toContain("a note");
  });

  it("creates nothing when the engineer says no", async () => {
    const written: string[] = [];
    await expect(confirmInstallPlan({ answers: sampleAnswers(), notes: [], prompter: scriptedPrompter([false]), write: (text) => written.push(text) }))
      .rejects.toThrow("install declined; nothing was created");
    expect(written.join("")).toContain("Estimated monthly total");
  });
});
