// FR-017 and FR-022: before agentx init creates anything, it shows every stack, role, secret, app
// and setting it will create, and an estimated monthly cost at a stated usage, then asks. No test
// here reaches AWS, GitHub or Slack.
import { describe, expect, it } from "vitest";
import { environmentStackName } from "@agentx/contracts";
import { confirmInstallPlan, estimateMonthlyCost, installPlanText, planSummary } from "../../packages/cli/src/init/plan.js";
import { sampleAnswers, scriptedPrompter } from "../support/init-fakes.js";

describe("install plan", () => {

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
      "The network and sign-in, the Rovara service and the Slack connection, in AWS account 123456789012 (us-east-1).",
      "Building them takes about 21 minutes, and you can leave while it runs.",
    ]);
    expect(plan.sections[1]?.lines).toEqual(["An app named \"AgentX acme (staging)\" owned by acme. It can read code and open pull requests in the repositories you choose."]);
    expect(plan.sections[4]?.lines).toEqual(["The ready screen gives you the command that removes everything, the coding machines' disks too."]);
  });

  it("FR-030: says developer sign-in is turned on with the Slack connection, with no second approval", () => {
    expect(plan.sections[2]?.lines).toEqual([
      "An app named \"AgentX acme (staging)\" in the Slack workspace you choose.",
      "Developers sign in to Rovara with Slack. It is turned on with the Slack connection, with no separate approval.",
    ]);
  });

  it("FR-023 and FR-025: names the budget and the alert address", () => {
    expect(plan.sections[3]?.lines).toEqual([
      "A budget alert at $260 a month for the whole account.",
      "Alerts go to ops@example.com. AWS sends a confirmation email there while the build runs.",
    ]);
  });

  it("keeps stacks, roles and secret paths for Show every resource only", () => {
    expect(plan.resources.some((line) => line.includes(environmentStackName("staging", "control-plane")))).toBe(true);
    expect(JSON.stringify(plan.sections)).not.toMatch(/agentx-staging-|arn:aws|AWS::/);
  });

});
