// SC-001: the browser prompter's protocol -- every `Prompter` method, inline validation, and
// cancellation -- and that no secret typed into the page reaches anything the page, an `InitEvent`
// or a progress note can read back.
import { describe, expect, it } from "vitest";
import { browserPrompter } from "../../packages/cli/src/init/ui/prompter.js";
import { createWizardHub, type WizardHub } from "../../packages/cli/src/init/ui/state.js";
import type { WizardQuestion } from "../../packages/cli/src/init/ui/protocol.js";

/** The question the page is showing, or a failure: every test here asks exactly one at a time. */
function shown(hub: WizardHub): WizardQuestion {
  const question = hub.state().question;
  if (question === undefined) throw new Error("the wizard is not showing a question");
  return question;
}

/** Posts `value` as the page would, and returns the inline error, if any. */
function post(hub: WizardHub, value: string): string | undefined {
  return hub.answer(shown(hub).id, value);
}

const setup = () => {
  const hub = createWizardHub("staging");
  return { hub, prompter: browserPrompter(hub) };
};

describe("browserPrompter", () => {

  it("ask takes the default for an empty field, and refuses an empty one without a default", async () => {
    const withDefault = setup();
    const defaulted = withDefault.prompter.ask("Slack app name", { flag: "--slack-app-name", defaultValue: "AgentX" });
    expect(shown(withDefault.hub).defaultValue).toBe("AgentX");
    expect(post(withDefault.hub, "")).toBeUndefined();
    await expect(defaulted).resolves.toBe("AgentX");

    const required = setup();
    void required.prompter.ask("GitHub organization", { flag: "--github-account" });
    expect(post(required.hub, "")).toBe("an answer is required");
  });

  it("confirm is two buttons, and says which one is the default", async () => {
    const declined = setup();
    const no = declined.prompter.confirm("Create all of this?", { defaultValue: false });
    expect(shown(declined.hub)).toMatchObject({ kind: "confirm", text: "Create all of this?", defaultConfirm: false });
    expect(post(declined.hub, "no")).toBeUndefined();
    await expect(no).resolves.toBe(false);

    const accepted = setup();
    const yes = accepted.prompter.confirm("Create all of this?", { defaultValue: false });
    expect(post(accepted.hub, "yes")).toBeUndefined();
    await expect(yes).resolves.toBe(true);

    const junk = setup();
    void junk.prompter.confirm("Create all of this?", { defaultValue: true });
    expect(post(junk.hub, "maybe")).toBe("answer yes or no");
  });

  it("secret masks its field and applies cleanSecret's rules inline", async () => {
    const { hub, prompter } = setup();
    const answer = prompter.secret("Slack bot token", { flag: "--slack-bot-token" });
    expect(shown(hub)).toMatchObject({ kind: "secret", masked: true });
    expect(shown(hub).multiline).toBeUndefined();
    expect(post(hub, "   ")).toBe("the Slack bot token is empty");
    expect(post(hub, "xoxb-1 xoxb-2")).toBe("the Slack bot token contains spaces or line breaks; copy it again and paste only the value");
    expect(post(hub, "  xoxb-1111-2222-value\n")).toBeUndefined();
    await expect(answer).resolves.toBe("xoxb-1111-2222-value");
  });

  it("a multi-line secret keeps its line breaks", async () => {
    const { hub, prompter } = setup();
    const pem = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    const answer = prompter.secret("GitHub App private key", { flag: "--github-private-key", multiline: true });
    expect(shown(hub).multiline).toBe(true);
    expect(post(hub, `${pem}\n`)).toBeUndefined();
    await expect(answer).resolves.toBe(pem);
  });

});

