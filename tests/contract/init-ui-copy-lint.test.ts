// tests/contract/init-ui-copy-lint.test.ts
// Spec 048 FR-081 and SC-011: the copy-lint rules. Each rule is proven by a seeded example that
// must fail it, and good copy must pass every rule. Task 17 runs the rules over the whole journey.
import { describe, expect, it } from "vitest";
import { environmentStackName } from "@agentx/contracts";
import { WAITING_STEP_PLAIN } from "../../packages/cli/src/init/commands.js";
import type { WizardQuestion } from "../../packages/cli/src/init/ui/protocol.js";
import { settingsFields } from "../../packages/cli/src/init/settings-form.js";
import { COPY_RULES, lintCopy, quotedStrings, stateEntries } from "../support/copy-lint.js";
import { FINISH, FIRST_RUN, harness, SIGNIN, SLACK } from "../support/init-ui-harness.js";
import { fakeWizardOperator } from "../support/wizard-browser.js";

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
    // Only the package itself: another package whose name starts the same is not it.
    expect(lintCopy([{ where: "page", text: "Install @charterarc/agentxtools first.", context: "page" as const }])).toEqual([]);
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

describe("SC-011: the whole install, as the page shows it", () => {
  it("a first install says no internal word anywhere on the page", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    expect(lintCopy(operator.states.flatMap((state, index) => stateEntries(state, `state ${index}`)))).toEqual([]);
  });

  it("a failed and retried step says no internal word either", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    const operator = fakeWizardOperator([...FIRST_RUN, "retry", ...SLACK, ...SIGNIN, ...FINISH], {
      beforeAnswer: async (question) => { if (question.text === "The install stopped. What next?") h.deployer.fail.clear(); },
    });
    expect(await h.run(["--ui"], { openBrowser: operator.open })).toBe(0);
    await operator.settled();
    expect(lintCopy(operator.states.flatMap((state, index) => stateEntries(state, `state ${index}`)))).toEqual([]);
  });

  it("a stopped install says no internal word, and never Finished", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    const { operator } = await h.runUi([...FIRST_RUN, "stop"]);
    expect(lintCopy(operator.states.flatMap((state, index) => stateEntries(state, `state ${index}`)))).toEqual([]);
  });

  // Review fix round 1: a waiting step carries a `message` (WizardStep.message) the earlier three
  // journeys never reach, since none of them pauses on someone else. Driving one here (the same
  // script as commands.ts's "a run paused waiting on a Slack admin's approval" test) proves
  // stateEntries actually walks a waiting step's message, and that the whole state history still
  // lints clean with it present.
  it("a run paused waiting on a Slack admin's approval says no internal word anywhere on the page", async () => {
    const h = await harness();
    const operator = fakeWizardOperator([...FIRST_RUN, "approval"]);
    const code = await h.run(["--ui"], { openBrowser: operator.open });
    await operator.settled();
    expect(code).toBe(0);
    // Not vacuous: a step really did reach "waiting" with a message, in some state of the run.
    expect(operator.states.some((state) => state.steps.some((step) => step.status === "waiting" && step.message !== undefined))).toBe(true);
    expect(lintCopy(operator.states.flatMap((state, index) => stateEntries(state, `state ${index}`)))).toEqual([]);
  });

  it("FR-010 and FR-011: every question of a first install has a label, a why line, and verb buttons", async () => {
    const h = await harness();
    const { operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    const questions = new Map<string, WizardQuestion>(operator.states.flatMap((state) => (state.question === undefined ? [] : [[state.question.id, state.question] as const])));
    // Spec 048 FR-020: the settings are one form, so each of its fields is held to the same words.
    const fields = new Map([...questions.values()].flatMap((question) => (question.fields ?? []).map((field) => [`${question.text}/${field.name}`, field] as const)));
    expect(questions.size + fields.size).toBeGreaterThan(20);
    for (const question of questions.values()) {
      expect({ text: question.text, label: question.label }).toMatchObject({ label: expect.stringMatching(/\S/) as unknown });
      expect({ text: question.text, why: question.why }).toMatchObject({ why: expect.stringMatching(/\S/) as unknown });
      if (question.kind === "ask" && question.defaultValue !== undefined) expect({ text: question.text, hint: question.hint }).toMatchObject({ hint: expect.stringMatching(/\S/) as unknown });
      for (const button of question.buttons ?? []) expect(["Yes", "No"]).not.toContain(button.label);
    }
    // The settings form shows all 18 settings; a text field with a default says what empty means.
    expect([...fields.keys()].filter((where) => where.startsWith("Your settings/"))).toHaveLength(18);
    const withDefault = new Set(settingsFields({ env: "staging", flags: {}, fixed: false, budgetWhy: "" }).filter((field) => field.choices === undefined && field.defaultValue !== undefined).map((field) => field.name));
    expect(withDefault.size).toBeGreaterThan(0);
    for (const [where, field] of fields) {
      expect({ where, label: field.label }).toMatchObject({ label: expect.stringMatching(/\S/) as unknown });
      expect({ where, why: field.why }).toMatchObject({ why: expect.stringMatching(/\S/) as unknown });
      if (field.choices === undefined && withDefault.has(field.name)) expect({ where, hint: field.hint }).toMatchObject({ hint: expect.stringMatching(/\S/) as unknown });
    }
  });

  it("SC-001: every state shows the phase, step N of 5 and the time left", async () => {
    const h = await harness();
    const { operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    for (const state of operator.states) {
      expect(state.journey.stepCount).toBe(5);
      expect(state.journey.stepNumber).toBeGreaterThanOrEqual(1);
      expect(state.journey.phases.find((phase) => phase.id === state.journey.current)?.title).toMatch(/\S/);
      expect(state.journey.timeLeftText).toMatch(/\S/);
    }
  });

  // Controller ruling: these two reasons never reach a WizardState (they are folded into the
  // terminal's own stoppedLine, in commands.ts's catch block), so stateEntries never sees them;
  // they still have to pass the same rules (FR-081), since the terminal is part of the install too.
  it("the terminal's own waiting reasons pass the copy-lint too", () => {
    const entries = Object.entries(WAITING_STEP_PLAIN).map(([id, text]) => ({ where: `waiting reason: ${id}`, text, context: "page" as const }));
    expect(lintCopy(entries)).toEqual([]);
  });
});
