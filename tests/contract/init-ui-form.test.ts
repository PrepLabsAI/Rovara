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
  it("shows every field with its page label, masks the secret, and resolves with every value", async () => {
    const hub = createWizardHub("staging");
    const answer = browserPrompter(hub).form?.("Paste the Slack values", FIELDS, {});
    expect(shown(hub)).toMatchObject({ kind: "form", text: "Paste the Slack values" });
    expect(shown(hub).fields?.map((field) => [field.name, field.label, field.masked === true])).toEqual([
      ["clientId", "Client ID", false], ["botToken", "Bot User OAuth Token", true], ["appName", "Slack app name", false],
    ]);
    expect(shown(hub).fields?.[2]?.hint).toBe("Leave empty to use AgentX acme (staging).");
    hub.answer(shown(hub).id, JSON.stringify({ clientId: "1111.2222", botToken: TEST_BOT_TOKEN, appName: "" }));
    await expect(answer).resolves.toEqual({ clientId: "1111.2222", botToken: TEST_BOT_TOKEN, appName: "AgentX acme (staging)" });
  });

  it("a refused form keeps valid plain values and never echoes a secret", async () => {
    const hub = createWizardHub("staging");
    const answer = browserPrompter(hub).form?.("Paste the Slack values", FIELDS, {});
    const first = shown(hub).id;
    expect(hub.answer(first, JSON.stringify({ clientId: "not-an-id", botToken: TEST_BOT_TOKEN, appName: "Ours" }))).toBe("Check the field marked below.");
    const again = shown(hub);
    expect(again.id).not.toBe(first);
    expect(again.fields?.find((field) => field.name === "clientId")?.error).toBe("the Client ID is two numbers joined by a dot");
    expect(again.fields?.find((field) => field.name === "appName")?.value).toBe("Ours");
    expect(again.fields?.find((field) => field.name === "botToken")?.value).toBeUndefined();
    expect(JSON.stringify(hub.snapshot())).not.toContain(TEST_BOT_TOKEN);
    hub.answer(again.id, JSON.stringify({ clientId: "1111.2222", botToken: TEST_BOT_TOKEN, appName: "Ours" }));
    await expect(answer).resolves.toEqual({ clientId: "1111.2222", botToken: TEST_BOT_TOKEN, appName: "Ours" });
  });

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

  it("asks the same values one by one in the terminal", async () => {
    const prompter = scriptedPrompter(["1111.2222", TEST_BOT_TOKEN, ""]);
    await expect(askForm(prompter, "Paste the Slack values", FIELDS)).resolves.toEqual({ clientId: "1111.2222", botToken: TEST_BOT_TOKEN, appName: "AgentX acme (staging)" });
    expect(prompter.asked).toEqual(["Slack app Client ID (Basic Information, App Credentials)", "Slack bot token", "Slack app name"]);
  });
});

describe("spec 048 phase 2: richer forms", () => {
  // A flag with no entry in the page's question-copy catalog (question-copy.ts), so the choices
  // here pass through unrelabelled: this test is about a choice field's own mechanics, not the
  // catalog's label override (covered separately below, by a field using the real --engine flag).
  const engine: FormField = { name: "engine", question: "Deploy engine", flag: "--test-engine", defaultValue: "templates", section: "advanced", choices: [{ value: "templates", label: "Published templates" }, { value: "cdk", label: "From source" }] };
  const email: FormField = { name: "email", question: "Your email", flag: "--admin-email" };
  const signing: FormField = { name: "signing", question: "Signing Secret", flag: "--slack-signing-secret", secret: true };
  const client: FormField = { name: "client", question: "Client Secret", flag: "--slack-client-secret", secret: true };

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

  it("starts from the values it is given, but never prefills a secret", () => {
    const hub = createWizardHub("staging");
    void browserPrompter(hub).form?.("Your Slack app's values", [email, signing], { values: { email: "kept@example.com", signing: "a".repeat(32) } });
    const fields = hub.state().question?.fields ?? [];
    expect(fields.find((field) => field.name === "email")?.value).toBe("kept@example.com");
    expect(fields.find((field) => field.name === "signing")).not.toHaveProperty("value");
    expect(JSON.stringify(hub.snapshot())).not.toContain("a".repeat(32));
  });

  it("a cross-field refusal marks the field, keeps plain values, and empties every secret", () => {
    const hub = createWizardHub("staging");
    const same = "f".repeat(32);
    void browserPrompter(hub).form?.("Your Slack app's values", [email, client, signing], {
      crossCheck: (values) => (values.client === values.signing ? { signing: "This is the Client Secret again. Copy the Signing Secret, just below it." } : undefined),
    });
    const id = hub.state().question?.id ?? "";
    expect(hub.answer(id, JSON.stringify({ email: "a@example.com", client: same, signing: same }))).toBe("Check the field marked below.");
    const fields = hub.state().question?.fields ?? [];
    expect(fields.find((field) => field.name === "signing")?.error).toBe("This is the Client Secret again. Copy the Signing Secret, just below it.");
    expect(fields.find((field) => field.name === "email")?.value).toBe("a@example.com");
    expect(JSON.stringify(hub.snapshot())).not.toContain(same);
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

  it("a choice field using a real flag shows the question-copy catalog's own labels (Task 6 relies on this)", () => {
    const hub = createWizardHub("staging");
    const catalogEngine: FormField = { name: "engine", question: "Deploy engine", flag: "--engine", defaultValue: "templates", choices: [{ value: "templates", label: "templates" }, { value: "cdk", label: "cdk" }] };
    void browserPrompter(hub).form?.("Your settings", [catalogEngine], {});
    const field = hub.state().question?.fields?.find((each) => each.name === "engine");
    expect(field?.choices).toEqual([
      { value: "templates", label: "Published templates (recommended)" },
      { value: "cdk", label: "From AgentX's source code, for contributors" },
    ]);
  });
});
