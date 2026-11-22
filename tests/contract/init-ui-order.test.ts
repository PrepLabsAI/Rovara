import { installGatewayFixture } from "../support/install-gateway.js";
// Spec 048 FR-031, FR-035, FR-072, SC-006 and SC-015: the page and the terminal ask in the same
// order and run the same early checks; once the build starts, only Connect GitHub and Slack and Finish wait.
import { describe, expect, it } from "vitest";
import { ADMIN_EMAIL } from "../support/setup-fakes.js";
import { scriptedPrompter, settingsScript } from "../support/init-fakes.js";
import { FINISH, FIRST_RUN, harness, SIGNIN, SLACK, TERMINAL_SLACK } from "../support/init-ui-harness.js";
import { ADVANCED_QUESTION } from "../../packages/cli/src/init/prompts.js";
import { SETTINGS_TITLE, settingsFields } from "../../packages/cli/src/init/settings-form.js";
import { SLACK_VALUES_TITLE, slackValuesFields } from "../../packages/cli/src/init/slack-app.js";

installGatewayFixture();

/** The terminal's questions, with each form's own questions folded into the form's title, as the page asks them. */
function folded(asked: readonly string[]): string[] {
  const settings = new Set([...settingsFields({ env: "staging", flags: {}, fixed: false, budgetWhy: "" }).map((field) => field.question), ADVANCED_QUESTION]);
  const slack = new Set(slackValuesFields({ client: true, secretFlags: {}, signinFlags: {} }).map((field) => field.question));
  const out: string[] = [];
  for (const question of asked) {
    const title = settings.has(question) ? SETTINGS_TITLE : slack.has(question) ? SLACK_VALUES_TITLE : question;
    if (out.at(-1) !== title || (title !== SETTINGS_TITLE && title !== SLACK_VALUES_TITLE)) out.push(title);
  }
  return out;
}

describe("the install's order", () => {
  it("FR-072 and SC-015: the terminal asks the same questions in the same order as the page", async () => {
    const page = await harness();
    const { operator } = await page.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    const terminal = await harness();
    const prompter = scriptedPrompter([...settingsScript({ email: ADMIN_EMAIL, owner: "acme", advanced: { alertEmail: "ops@example.com" } }), true, ...TERMINAL_SLACK, ...FINISH]);
    expect(await terminal.run(["--no-ui"], { prompter })).toBe(0);
    expect(folded(prompter.asked)).toEqual(operator.asked);
  });

});
