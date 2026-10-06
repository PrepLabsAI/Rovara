// FR-017 and FR-022: before agentx init creates anything, it shows every stack, role, secret, app
// and setting it will create, and an estimated monthly cost at a stated usage, then asks. No test
// here reaches AWS, GitHub or Slack.
import { describe, expect, it } from "vitest";
import { environmentStackName } from "@agentx/contracts";
import { confirmInstallPlan, estimateMonthlyCost, installPlanText, planSummary } from "../../packages/cli/src/init/plan.js";
import { count, PRICES_CHECKED, STATED_USAGE } from "../../packages/cli/src/init/cost.js";
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
      ["Safety check model (Claude Haiku 4.5)", 2.5],
      ["Coding model (Claude Sonnet 4.6)", 75],
    ]);
    // 60 machine-hours x 30 GiB x ($0.08/GB-month / 730 hours/month) = $0.1972..., rounded to $0.20.
    expect(estimate.totalUsd).toBe(211.13);
    expect(estimate.unpriced).toEqual([]);
  });

  it("marks the Claude Haiku 4.5 classifier price as assumed, and only that one", () => {
    const estimate = estimateMonthlyCost(sampleAnswers().models);
    const classifier = estimate.lines.find((line) => line.item.startsWith("Safety check model"));
    expect(classifier?.usd).toBe(2.5);
    expect(classifier?.basis).toBe("1,000 checks at about $0.0025 each, assumed: no confirmed Bedrock rate");
    expect(estimate.lines.filter((line) => line.basis.includes("assumed"))).toEqual([classifier]);
  });

  it("prices GLM 4.7 lower, and names a model it has no price for instead of guessing", () => {
    expect(estimateMonthlyCost({ ...sampleAnswers().models, orchestrator: "zai.glm-4.7" }).totalUsd).toBe(193.13);
    const custom = estimateMonthlyCost({ ...sampleAnswers().models, worker: "us.anthropic.claude-opus-4-1-20250805-v1:0" });
    expect(custom.unpriced).toEqual(["us.anthropic.claude-opus-4-1-20250805-v1:0"]);
    expect(custom.lines.find((line) => line.item.startsWith("Coding model"))?.usd).toBeUndefined();
    expect(custom.totalUsd).toBe(136.13);
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
      "- Models: main model Claude Sonnet 4.6 (Amazon Bedrock), safety check model Claude Haiku 4.5 (Amazon Bedrock), coding model Claude Sonnet 4.6 (Amazon Bedrock)",
      "AgentX never answers itself or other bots. Messages other apps post for people: answered.",
      "Estimated monthly total: $211.13 at 1,000 turns, 100 coding sessions and 60 machine-hours a month",
      "To remove everything later, use the remove command in the ready summary. It deletes the coding machines' disks too.",
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
    await expect(confirmInstallPlan({ answers: sampleAnswers(), notes: [], prompter: scriptedPrompter([false]), write: (text) => written.push(text), page: false }))
      .rejects.toThrow("install declined; nothing was created");
    expect(written.join("")).toContain("Estimated monthly total");
  });
});

describe("spec 048 FR-029: the plan as a plain summary", () => {
  const answers = sampleAnswers({ adminEmail: "alice@example.com", signinMethods: "slack", budget: { monthlyUsd: 260, scope: "account" } });
  const plan = planSummary(answers, estimateMonthlyCost(answers.models), []);

  it("says what is created in AWS, GitHub and Slack by name, how long the build takes, and how to remove it", () => {
    expect(plan.sections.map((section) => section.title)).toEqual(["In AWS", "In GitHub", "In Slack", "Budget and alerts", "To remove it later"]);
    expect(plan.sections[0]?.lines).toEqual([
      "The network and sign-in, the AgentX service and the Slack connection, in AWS account 123456789012 (us-east-1).",
      "Building them takes about 21 minutes, and you can leave while it runs.",
    ]);
    expect(plan.sections[1]?.lines).toEqual(["An app named \"AgentX acme (staging)\" owned by acme. It can read code and open pull requests in the repositories you choose."]);
    expect(plan.sections[4]?.lines).toEqual(["The ready screen gives you the command that removes everything, the coding machines' disks too."]);
  });

  it("FR-030: says developer sign-in is turned on with the Slack connection, with no second approval", () => {
    expect(plan.sections[2]?.lines).toEqual([
      "An app named \"AgentX acme (staging)\" in the Slack workspace you choose.",
      "Developers sign in to AgentX with Slack. It is turned on with the Slack connection, with no separate approval.",
    ]);
  });

  it("FR-023 and FR-025: names the budget and the alert address", () => {
    expect(plan.sections[3]?.lines).toEqual([
      "A budget alert at $260 a month for the whole account.",
      "Alerts go to ops@example.com. AWS sends a confirmation email there while the build runs.",
    ]);
  });

  it("has a three-column cost table with its usage stated once, and every line priced or marked", () => {
    expect(plan.cost.rows.length).toBe(estimateMonthlyCost(answers.models).lines.length);
    for (const row of plan.cost.rows) expect(row.monthly).toMatch(/^(\$\d+\.\d{2}|not priced)$/);
    expect(plan.cost.usage).toBe(`At ${count(STATED_USAGE.turnsPerMonth)} turns, ${count(STATED_USAGE.workerSessionsPerMonth)} coding sessions and ${STATED_USAGE.workerInstanceHoursPerMonth} machine-hours a month, at us-east-1 list prices of ${PRICES_CHECKED}. Your bill will differ.`);
  });

  it("keeps stacks, roles and secret paths for Show every resource only", () => {
    expect(plan.resources.some((line) => line.includes(environmentStackName("staging", "control-plane")))).toBe(true);
    expect(JSON.stringify(plan.sections)).not.toMatch(/agentx-staging-|arn:aws|AWS::/);
  });

  it("on the page asks Create AgentX or Change answers; in the terminal keeps its confirm", async () => {
    const page = scriptedPrompter(["change"]);
    await expect(confirmInstallPlan({ answers, notes: [], prompter: page, write: () => undefined, page: true })).resolves.toBe("change");
    const terminal = scriptedPrompter([true]);
    await expect(confirmInstallPlan({ answers, notes: [], prompter: terminal, write: () => undefined, page: false })).resolves.toBe("create");
    expect(terminal.asked).toEqual(["Create all of this?"]);
  });
});
