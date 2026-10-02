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
      ["The Slack connection (Fargate, 0.5 vCPU, 1 GB, arm64)", 14.42],
      ["Coding machines (m6g.medium)", 2.31],
      ["Coding machine disks (30 GiB gp3)", 0.2],
      ["Kept workspaces", 16],
      ["API Gateway, Lambda, DynamoDB, SQS, Secrets Manager, KMS (including the invocation-signing key) and CloudWatch", 10],
      ["Main model (Claude Sonnet 4.6)", 25],
      ["Safety check model (Amazon Nova Lite)", 0.15],
      ["Coding model (Amazon Nova Pro)", 19.2],
    ]);
    // 60 machine-hours x 30 GiB x ($0.08/GB-month / 730 hours/month) = $0.1972..., rounded to $0.20.
    expect(estimate.totalUsd).toBe(152.98);
    expect(estimate.unpriced).toEqual([]);
  });

  it("marks the Claude Haiku 4.5 classifier price as assumed, and only that one", () => {
    const estimate = estimateMonthlyCost({ ...sampleAnswers().models, classifier: "us.anthropic.claude-haiku-4-5-20251001-v1:0" });
    const classifier = estimate.lines.find((line) => line.item.startsWith("Safety check model"));
    expect(classifier?.usd).toBe(2.5);
    expect(classifier?.basis).toBe("1,000 checks at about $0.0025 each, assumed: no confirmed Bedrock rate");
    expect(estimateMonthlyCost(sampleAnswers().models).lines.filter((line) => line.basis.includes("assumed"))).toEqual([]);
  });

  it("prices GLM 4.7 lower, and names a model it has no price for instead of guessing", () => {
    expect(estimateMonthlyCost({ ...sampleAnswers().models, orchestrator: "zai.glm-4.7" }).totalUsd).toBe(134.98);
    const custom = estimateMonthlyCost({ ...sampleAnswers().models, worker: "us.amazon.nova-premier-v1:0" });
    expect(custom.unpriced).toEqual(["us.amazon.nova-premier-v1:0"]);
    expect(custom.lines.find((line) => line.item.startsWith("Coding model"))?.usd).toBeUndefined();
    expect(custom.totalUsd).toBe(133.78);
  });

  it("prices the coding machine disk at the same usage as the coding machines, separately from the kept workspaces", () => {
    const estimate = estimateMonthlyCost(sampleAnswers().models);
    const rootVolume = estimate.lines.find((line) => line.item.startsWith("Coding machine disks"));
    expect(rootVolume?.usd).toBe(0.2);
    expect(rootVolume?.basis).toContain("the same usage as the coding machines above");
    expect(rootVolume?.basis).toContain("each disk is deleted with its machine, unlike the kept workspaces below");
  });
});

describe("install plan", () => {
  it("lists every stack, role, secret, app and setting it will create, and the cost", () => {
    const answers = sampleAnswers();
    const text = installPlanText(answers, estimateMonthlyCost(answers.models), []);
    for (const expected of [
      "AgentX will create the install staging in AWS account 123456789012 (us-east-1), from release 1.2.3 with published templates:",
      "agentx-staging-access, agentx-staging-foundation, agentx-staging-identity, agentx-staging-control-plane, agentx-staging-runtime, agentx-staging-slack",
      "IAM roles agentx-staging-cloudformation (CloudFormation deploys through it) and agentx-staging-operator (day-2 commands)",
      "the permission boundary agentx-staging-boundary, which every AgentX role carries; the stacks' own roles live under the IAM path /agentx/staging/",
      "Secrets agentx/staging/callback-signing-key, agentx/staging/github-app, agentx/staging/slack",
      "Settings under /agentx/staging/",
      "In GitHub: an app named \"AgentX acme (staging)\" owned by acme, with read and write access to contents, pull requests and issues, and read access to metadata. No webhook.",
      "In Slack: an app named \"AgentX acme (staging)\".",
      "- Alerts: email to ops@example.com, subscribed and tested at the end of the install",
      "- Models: main model Claude Sonnet 4.6 (Amazon Bedrock), safety check model Amazon Nova Lite (Amazon Bedrock), coding model Amazon Nova Pro (Amazon Bedrock)",
      "AgentX never answers itself or other bots. Messages other apps post for people: answered.",
      "Estimated monthly total: $152.98 at 1,000 turns, 100 coding sessions and 60 machine-hours a month",
      "To remove everything later, use the remove command on the ready screen. It deletes the coding machines' disks too.",
      "Coding machine disks (30 GiB gp3)",
      "KMS (including the invocation-signing key)",
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
    expect(text).toContain("- Alerts: https://events.pagerduty.com/... (the full address is kept in agentx/staging/alert-endpoint), subscribed and tested at the end of the install");
    expect(text).toContain("agentx/staging/alert-endpoint");
    expect(text).not.toContain("agentx-staging-identity");
    expect(text).toContain("a note");
  });

  it("lists agentx/<env>/openrouter when init stores the OpenRouter key, and only reads a secret you made yourself", () => {
    const openRouterModels = { orchestrator: "a/b", classifier: "a/b", worker: "a/b", providers: { orchestrator: "openrouter", classifier: "openrouter", worker: "openrouter" } } as const;
    const answers = sampleAnswers({ models: openRouterModels });
    const text = installPlanText(answers, estimateMonthlyCost(answers.models), [], { storesOpenRouterKey: true, openRouterProviders: ["deepinfra/turbo"] });
    expect(text).toContain("Secrets agentx/staging/callback-signing-key, agentx/staging/github-app, agentx/staging/slack, agentx/staging/openrouter");
    expect(text).toContain("- OpenRouter: your API key is stored in the new secret agentx/staging/openrouter; provider allowlist deepinfra/turbo; fallbacks disabled, data_collection=deny");

    const own = sampleAnswers({ models: { ...openRouterModels, openRouter: { secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:mine-AbCdEf" } } });
    const ownText = installPlanText(own, estimateMonthlyCost(own.models), []);
    expect(ownText).not.toContain("agentx/staging/openrouter");
    expect(ownText).toContain("- OpenRouter: read existing secret arn:aws:secretsmanager:us-east-1:123456789012:secret:mine-AbCdEf");
  });

  it("names the budget and says alerts are subscribed during init", () => {
    const text = installPlanText(sampleAnswers({ budget: { monthlyUsd: 100, scope: "tag" } }), estimateMonthlyCost(sampleAnswers().models), []);
    expect(text).toContain("- Alerts: email to ops@example.com, subscribed and tested at the end of the install");
    expect(text).toContain("- Budget agentx-staging-monthly: $100 a month for costs tagged agentx:env=staging, alerting at 80% spent and 100% forecast");
    expect(installPlanText(sampleAnswers(), estimateMonthlyCost(sampleAnswers().models), [])).toContain("- Budget: none");
  });

  it("names the budget for the whole account when the scope is account", () => {
    const text = installPlanText(sampleAnswers({ budget: { monthlyUsd: 250, scope: "account" } }), estimateMonthlyCost(sampleAnswers().models), []);
    expect(text).toContain("- Budget agentx-staging-monthly: $250 a month for the whole account, alerting at 80% spent and 100% forecast");
  });

  it("creates nothing when the engineer says no", async () => {
    const written: string[] = [];
    await expect(confirmInstallPlan({ answers: sampleAnswers(), notes: [], prompter: scriptedPrompter([false]), write: (text) => written.push(text) }))
      .rejects.toThrow("install declined; nothing was created");
    expect(written.join("")).toContain("Estimated monthly total");
  });
});
