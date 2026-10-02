// tests/contract/init-ui-form.test.ts
// Spec 048 FR-012: one screen can ask several related values, check each on its own field, and
// keep the valid ones when another is refused. A secret is never sent back to the page.
import { describe, expect, it } from "vitest";
import { askForm, checkSlackBotToken, fieldCheck, type FormField } from "../../packages/cli/src/init/prompts.js";
import { answeringSlackInstall } from "../../packages/cli/src/init/commands.js";
import { browserPrompter } from "../../packages/cli/src/init/ui/prompter.js";
import { createWizardHub, type WizardHub } from "../../packages/cli/src/init/ui/state.js";
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
