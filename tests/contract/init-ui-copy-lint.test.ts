// tests/contract/init-ui-copy-lint.test.ts
// Spec 048 FR-081 and SC-011: the copy-lint rules. Each rule is proven by a seeded example that
// must fail it, and good copy must pass every rule. Task 17 runs the rules over the whole journey.
import { describe, expect, it } from "vitest";
import { COPY_RULES, lintCopy, quotedStrings } from "../support/copy-lint.js";

const SEEDED: Record<string, string> = {
  "phase-or-spec-number": "To remove it later, follow the teardown guide (agentx destroy arrives in phase 15e).",
  "dotted-config-key": "Mentions people post through other apps: accept (slack.appPostedMessages).",
  "cloudformation-type": "Resource AWS::Lambda::Function failed to create",
  "cloudformation-logical-id": "BrokerE1355FD6 failed to create",
  "raw-slack-markup": "Talk to it: mention <@U0C6V3H9C8Y> in #payments",
  "raw-slack-id": "Slack app A0APP is installed in workspace T0TEAM.",
  "aws-arn": "Signed in as arn:aws:sts::123456789012:assumed-role/Admin/alice.",
  "enter-for": "Permission boundary policy ARN (Enter for AgentX's default boundary)",
  "empty-leave-empty-for": "Leave empty for ",
  "error-code": "AgentX error [INTERNAL_ERROR]: the step failed",
  "finished-on-failed-run": "Finished",
  "day-two-without-env": "A test alarm any time: agentx alerts test",
  "unpublished-package": "Developers sign in with: npx @charterarc/agentx login https://abc.example.com",
  "terminal-instruction": "Once it is installed, run agentx init --env staging --region us-east-1 again.",
};

const GOOD = [
  "AgentX installs into AWS account 123456789012 in us-east-1.",
  "Open github.com",
  "Pick your workspace in api.slack.com, then come back to this tab.",
  "Mention @agentx-acme-production in #payments.",
  "Leave empty to use production.",
  "Optional. Leave empty to use AgentX's default.",
  "Start the AgentX service: usually 13 minutes",
  "Claude Sonnet 4.6 (recommended; about $0.025 a turn)",
  "The Bot User OAuth Token is under OAuth & Permissions. It starts with xoxb-.",
  "Keep the terminal open and your computer awake until the install is done.",
  "the steps that finished are kept",
];

describe("copy-lint rules", () => {
  it("has a seeded failing example for every rule, and no rule without one", () => {
    expect(Object.keys(SEEDED).sort()).toEqual(COPY_RULES.map((rule) => rule.id).sort());
  });

  for (const rule of COPY_RULES) {
    it(`fails the seeded example of ${rule.id}`, () => {
      const found = lintCopy([{ where: "seed", text: SEEDED[rule.id] ?? "", context: "page", failedRun: true }]);
      expect(found.some((line) => line.startsWith(`${rule.id} in seed`))).toBe(true);
    });
  }

  it("passes good copy", () => {
    expect(lintCopy(GOOD.map((text, index) => ({ where: `good ${index}`, text, context: "page", failedRun: true })))).toEqual([]);
  });

  it("allows raw IDs, ARNs, codes and commands in technical details only", () => {
    const technical = [SEEDED["aws-arn"], SEEDED["raw-slack-id"], SEEDED["error-code"], SEEDED["cloudformation-type"], SEEDED["terminal-instruction"]];
    expect(lintCopy(technical.map((text) => ({ where: "details", text: text ?? "", context: "details" })))).toEqual([]);
  });

  it("allows a versioned published invocation and does not flag it as unpublished", () => {
    expect(lintCopy([{ where: "details", text: "npx @charterarc/agentx@1.2.3 status --env production", context: "details" as const }])).toEqual([]);
  });

  it("allows a command on Stop for now, the lost connection notice and the ready screen, but never without --env", () => {
    const resume = { where: "stop", text: "agentx --env staging init --region us-east-1", context: "stop-for-now" as const };
    expect(lintCopy([resume])).toEqual([]);
    expect(lintCopy([{ where: "ready", text: "agentx alerts test", context: "ready" }])).toHaveLength(1);
  });

  it("allows Finished on a run that did not fail", () => {
    expect(lintCopy([{ where: "ok", text: "Finished", context: "page", failedRun: false }])).toEqual([]);
  });

  it("reads the string literals out of the page's source", () => {
    expect(quotedStrings(`a.textContent = "Show technical log"; b = 'x'; c = \`y\`;`)).toEqual(["Show technical log", "x", "y"]);
  });
});
