// Spec 048 FR-031, FR-035, FR-072, SC-006 and SC-015: the page and the terminal ask in the same
// order and run the same early checks; once the build starts, only Connect GitHub and Slack and Finish wait.
import { describe, expect, it } from "vitest";
import { ADMIN_EMAIL } from "../support/setup-fakes.js";
import { passingChecks, scriptedPrompter, settingsScript } from "../support/init-fakes.js";
import { FINISH, FIRST_RUN, harness, SIGNIN, SLACK, TERMINAL_SLACK } from "../support/init-ui-harness.js";
import { fakeWizardOperator } from "../support/wizard-browser.js";
import { ADVANCED_QUESTION } from "../../packages/cli/src/init/prompts.js";
import { SETTINGS_TITLE, settingsFields } from "../../packages/cli/src/init/settings-form.js";
import { SLACK_VALUES_TITLE, slackValuesFields } from "../../packages/cli/src/init/slack-app.js";

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

  it("FR-018, FR-028 and FR-072: both run the account checks before the settings, and the answer checks before the plan", async () => {
    for (const mode of ["page", "terminal"] as const) {
      const h = await harness();
      const events: string[] = [];
      const checks = passingChecks({ ec2Quota: async () => { events.push("account"); return 32; }, converse: async () => { events.push("answers"); } });
      const mark = (question: string) => { if (question === SETTINGS_TITLE || question.startsWith("Your email")) events.push("settings"); if (question === "Create all of this?") events.push("plan"); };
      if (mode === "page") {
        const operator = fakeWizardOperator([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH], { beforeAnswer: async (question) => mark(question.text) });
        expect(await h.run(["--ui"], { openBrowser: operator.open, checks })).toBe(0);
        await operator.settled();
      } else {
        const inner = scriptedPrompter([...settingsScript({ email: ADMIN_EMAIL, owner: "acme", advanced: { alertEmail: "ops@example.com" } }), true, ...TERMINAL_SLACK, ...FINISH]);
        const prompter = { ...inner, ask: (q: string, o: Parameters<typeof inner.ask>[1]) => { mark(q); return inner.ask(q, o); }, confirm: (q: string, o: Parameters<typeof inner.confirm>[1]) => { mark(q); return inner.confirm(q, o); } };
        expect(await h.run(["--no-ui"], { prompter, checks })).toBe(0);
      }
      const first = (name: string) => events.indexOf(name);
      expect({ mode, order: [first("account"), first("settings"), first("answers"), first("plan")].every((at, index, all) => at >= 0 && (index === 0 || at > (all[index - 1] ?? -1))) }).toEqual({ mode, order: true });
    }
  });

  it("FR-035 and SC-006: once the build starts, the run waits only in Connect GitHub and Slack and Finish", async () => {
    const h = await harness();
    const { operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    const built = operator.states.findIndex((state) => state.steps.some((step) => step.id === "access" && step.status !== "pending"));
    expect(built).toBeGreaterThan(0);
    const waitingAfter = operator.states.slice(built).filter((state) => state.question !== undefined || state.waitingOnYou);
    expect(waitingAfter.length).toBeGreaterThan(0);
    for (const state of waitingAfter) expect(["connect", "finish"]).toContain(state.journey.current);
  });

  it("before the build the page asks only the settings and the plan, and the GitHub app is made after every stack is up", async () => {
    const h = await harness();
    const { operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    const built = operator.states.findIndex((state) => state.steps.some((step) => step.id === "access" && step.status !== "pending"));
    const before = [...new Set(operator.states.slice(0, built).flatMap((state) => (state.question === undefined ? [] : [state.question.text])))];
    expect(before).toEqual([SETTINGS_TITLE, "Create all of this?"]);
    const github = operator.states.findIndex((state) => state.steps.some((step) => step.id === "github-app" && step.status !== "pending"));
    expect(github).toBeGreaterThan(built);
    expect(operator.states[github]?.steps.find((step) => step.id === "slack-service")?.status).toBe("done");
  });
});
