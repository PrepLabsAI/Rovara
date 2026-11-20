// tests/contract/init-ui-form.test.ts
// Spec 048 FR-012: one screen can ask several related values, check each on its own field, and
// keep the valid ones when another is refused. A secret is never sent back to the page.
import { describe, expect, it } from "vitest";
import { askForm, checkSlackBotToken, fieldCheck, type FormField } from "../../packages/cli/src/init/prompts.js";
import { answeringSlackInstall } from "../../packages/cli/src/init/commands.js";
import { browserPrompter } from "../../packages/cli/src/init/ui/prompter.js";
import { createWizardHub, NEW_TAB_NOTE, type WizardHub } from "../../packages/cli/src/init/ui/state.js";
import { scriptedPrompter, TEST_BOT_TOKEN } from "../support/init-fakes.js";

const FIELDS: FormField[] = [
  { name: "clientId", question: "Slack app Client ID (Basic Information, App Credentials)", flag: "--slack-client-id", validate: (value) => (/^\d+\.\d+$/.test(value) ? undefined : "the Client ID is two numbers joined by a dot") },
  { name: "botToken", question: "Slack bot token", flag: "--slack-bot-token", secret: true, validate: fieldCheck(checkSlackBotToken) },
  { name: "appName", question: "Slack app name", flag: "--slack-app-name", defaultValue: "AgentX acme (staging)" },
];

const shown = (hub: WizardHub) => {
  const question = hub.state().question;
  if (question === undefined) throw new Error("no question shown");
  return question;
};

describe("forms", () => {

  it("names how many fields to check when more than one is refused", async () => {
    const hub = createWizardHub("staging");
    void browserPrompter(hub).form?.("Paste the Slack values", FIELDS, {});
    expect(hub.answer(shown(hub).id, JSON.stringify({ clientId: "not-an-id", botToken: "not-a-token", appName: "Ours" }))).toBe("Check the 2 fields marked below.");
    expect(shown(hub).error).toBe("Check the 2 fields marked below.");
  });

  it("--slack-install keeps the page's form, and adds none to a prompter without one", async () => {
    const hub = createWizardHub("staging");
    const prompter = answeringSlackInstall(browserPrompter(hub), "installed");
    const answer = askForm(prompter, "Paste the Slack values", FIELDS);
    expect(shown(hub)).toMatchObject({ kind: "form", text: "Paste the Slack values" });
    hub.answer(shown(hub).id, JSON.stringify({ clientId: "1111.2222", botToken: TEST_BOT_TOKEN, appName: "" }));
    await expect(answer).resolves.toEqual({ clientId: "1111.2222", botToken: TEST_BOT_TOKEN, appName: "AgentX acme (staging)" });
    expect(Object.hasOwn(answeringSlackInstall(scriptedPrompter([]), "installed"), "form")).toBe(false);
  });

  it("refuses a body that is not a form", () => {
    const hub = createWizardHub("staging");
    void browserPrompter(hub).form?.("Paste the Slack values", FIELDS, {});
    expect(hub.answer(shown(hub).id, "not json")).toBe("the form could not be read; try again");
  });

});

describe("spec 048 phase 2: richer forms", () => {
  // A flag with no entry in the page's question-copy catalog (question-copy.ts), so the choices
  // here pass through unrelabelled: this test is about a choice field's own mechanics, not the
  // catalog's label override (covered separately below, by a field using the real --engine flag).
  const engine: FormField = { name: "engine", question: "Deploy engine", flag: "--test-engine", defaultValue: "templates", section: "advanced", choices: [{ value: "templates", label: "Published templates" }, { value: "cdk", label: "From source" }] };
  const email: FormField = { name: "email", question: "Your email", flag: "--admin-email" };

  it("a choice field takes its default when left empty, and refuses a value it does not list", async () => {
    const hub = createWizardHub("staging");
    const asked = browserPrompter(hub).form?.("Your settings", [email, engine], {}) ?? Promise.reject(new Error("no form"));
    const first = hub.state().question;
    expect(first?.fields?.[1]).toMatchObject({ name: "engine", section: "advanced", defaultValue: "templates", choices: engine.choices });
    expect(hub.answer(first?.id ?? "", JSON.stringify({ email: "a@example.com", engine: "terraform" }))).toBe("Check the field marked below.");
    const second = hub.state().question;
    expect(second?.fields?.find((field) => field.name === "engine")?.error).toBe("choose one of the options");
    expect(second?.fields?.find((field) => field.name === "email")?.value).toBe("a@example.com");
    expect(hub.answer(second?.id ?? "", JSON.stringify({ email: "a@example.com", engine: "" }))).toBeUndefined();
    await expect(asked).resolves.toEqual({ email: "a@example.com", engine: "templates" });
  });

  it("carries the summary, the forward button's label, the group and a field's link", () => {
    const hub = createWizardHub("staging");
    void browserPrompter(hub).form?.("Your settings", [{ ...engine, group: "How people sign in", help: { learnMoreUrl: "https://api.slack.com/apps", linkLabel: "Open your Slack apps" } }], {
      summary: ["Models: Claude Sonnet 4.6 on Amazon Bedrock."], help: { submitLabel: "Review the plan" },
    });
    const question = hub.state().question;
    expect(question?.summary).toEqual(["Models: Claude Sonnet 4.6 on Amazon Bedrock."]);
    expect(question?.submitLabel).toBe("Review the plan");
    expect(question?.fields?.[0]).toMatchObject({ group: "How people sign in", link: { url: "https://api.slack.com/apps", label: "Open your Slack apps", note: NEW_TAB_NOTE } });
  });

});
