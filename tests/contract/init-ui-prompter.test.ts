// SC-001: the browser prompter's protocol -- every `Prompter` method, inline validation, and
// cancellation -- and that no secret typed into the page reaches anything the page, an `InitEvent`
// or a progress note can read back.
import { describe, expect, it } from "vitest";
import { checkSlackBotToken, fieldCheck } from "../../packages/cli/src/init/prompts.js";
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
  it("ask shows the question and resolves with the posted answer", async () => {
    const { hub, prompter } = setup();
    const answer = prompter.ask("GitHub organization", { flag: "--github-account" });
    expect(shown(hub)).toMatchObject({ kind: "ask", text: "GitHub organization" });
    expect(post(hub, "  acme  ")).toBeUndefined();
    await expect(answer).resolves.toBe("acme");
    expect(hub.state().question).toBeUndefined();
  });

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

  it("a validator rejection is shown on the field and the question comes back, rather than failing the run", async () => {
    const { hub, prompter } = setup();
    const answer = prompter.ask("Alert email address", {
      flag: "--alert-email",
      validate: (value) => (value.includes("@") ? undefined : "that is not an email address"),
    });
    const first = shown(hub);
    expect(hub.answer(first.id, "nope")).toBe("that is not an email address");
    const again = shown(hub);
    expect(again.error).toBe("that is not an email address");
    expect(again.text).toBe("Alert email address");
    // A fresh id, so the refused answer cannot simply be resent.
    expect(again.id).not.toBe(first.id);
    expect(hub.answer(first.id, "nope")).toBe("that question is out of date; answer the one shown above");
    expect(hub.answer(again.id, "ops@example.com")).toBeUndefined();
    await expect(answer).resolves.toBe("ops@example.com");
  });

  it("choose offers every choice, takes the default for an empty answer, and refuses anything else", async () => {
    // A flag with no entry in the page's question-copy catalog (question-copy.ts), so the
    // choices here pass through unrelabelled: this test is about choose's own mechanics.
    const choices = [{ value: "cognito" as const, label: "AgentX signs people in" }, { value: "oidc" as const, label: "Your own provider" }];
    const picked = setup();
    const chosen = picked.prompter.choose("Sign-in", choices, { flag: "--not-a-real-flag", defaultValue: "cognito" });
    expect(shown(picked.hub)).toMatchObject({ kind: "choose", defaultValue: "cognito", choices });
    expect(post(picked.hub, "oidc")).toBeUndefined();
    await expect(chosen).resolves.toBe("oidc");

    const defaulted = setup();
    const takesDefault = defaulted.prompter.choose("Sign-in", choices, { flag: "--not-a-real-flag", defaultValue: "cognito" });
    expect(post(defaulted.hub, "")).toBeUndefined();
    await expect(takesDefault).resolves.toBe("cognito");

    const refused = setup();
    void refused.prompter.choose("Sign-in", choices, { flag: "--not-a-real-flag", defaultValue: "cognito" });
    expect(post(refused.hub, "saml")).toBe("choose one of the options");
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

  it("FR-012: a secret reaches only its caller, never the page's state, the log or a rejection message", async () => {
    const { hub, prompter } = setup();
    const token = "xoxb-1111-2222-SECRETbotTOKENvalue";
    hub.setSteps([{ id: "slack-app", title: "Create and install the Slack app" }]);
    hub.applyEvent({ kind: "step-started", id: "slack-app", title: "Create and install the Slack app" });
    hub.log("==> Create and install the Slack app");
    const answer = prompter.secret("Slack bot token", { flag: "--slack-bot-token" });
    // A refused paste must not come back with the value in the message either.
    expect(post(hub, `${token} extra`)).not.toContain(token);
    expect(JSON.stringify(hub.snapshot())).not.toContain("SECRETbotTOKEN");
    expect(post(hub, token)).toBeUndefined();
    await expect(answer).resolves.toBe(token);
    hub.log("done: Create and install the Slack app");
    hub.finish("AgentX environment staging is installed.");
    expect(JSON.stringify(hub.snapshot())).not.toContain("SECRETbotTOKEN");
  });

  it("closing the wizard cancels the question the run is waiting on", async () => {
    const { hub, prompter } = setup();
    const answer = prompter.secret("Slack signing secret", { flag: "--slack-signing-secret" });
    hub.close();
    await expect(answer).rejects.toThrow("the install wizard closed before the question was answered");
    await expect(prompter.ask("anything", { flag: "--none" })).rejects.toThrow("the install wizard has closed");
  });

  it("an answer to a question nobody is waiting on changes nothing", () => {
    const { hub } = setup();
    expect(hub.answer("no-such-question", "yes")).toBe("that question has already been answered");
  });
});

describe("the wizard's state", () => {
  it("builds the checklist from the InitEvent stream", () => {
    // A fixed clock, so the step's recorded startedAt and tookSeconds are exact values below.
    const hub = createWizardHub("staging", { now: () => 0 });
    hub.setSteps([
      { id: "prerequisites", title: "Check your AWS account" },
      { id: "access", title: "Deploy the access stack" },
      { id: "github-app", title: "Create the GitHub app" },
    ]);
    expect(hub.state().steps.map((step) => step.status)).toEqual(["pending", "pending", "pending"]);
    hub.applyEvent({ kind: "step-skipped", id: "prerequisites", title: "Check your AWS account" });
    hub.applyEvent({ kind: "step-started", id: "access", title: "Deploy the access stack" });
    hub.applyEvent({ kind: "step-done", id: "access", title: "Deploy the access stack" });
    hub.applyEvent({ kind: "step-waiting", id: "github-app", title: "Create the GitHub app", message: "install it on acme" });
    expect(hub.state().steps).toEqual([
      { id: "prerequisites", title: "Check your AWS account", status: "skipped", phase: "your-choices", usualSeconds: 30, usualText: "usually under a minute" },
      { id: "access", title: "Deploy the access stack", status: "done", phase: "build", usualSeconds: 60, usualText: "usually 1 minute", startedAt: "1970-01-01T00:00:00.000Z", tookSeconds: 0 },
      { id: "github-app", title: "Create the GitHub app", status: "waiting", message: "install it on acme", phase: "build", usualSeconds: 120, usualText: "usually 2 minutes" },
    ]);
  });

  it("gives a listener every state change and log line, then tells it the run is over", () => {
    const hub = createWizardHub("staging");
    const seen: string[] = [];
    hub.subscribe({
      state: (state) => seen.push(`state:${state.phase}:${state.steps.length}`),
      log: (line) => seen.push(`log:${line}`),
      closed: () => seen.push("closed"),
    });
    hub.log("fetching the release");
    hub.setSteps([{ id: "prerequisites", title: "Check your AWS account" }]);
    hub.finish("AgentX environment staging is installed.");
    hub.close();
    expect(seen).toEqual(["log:fetching the release", "state:running:1", "state:finished:1", "closed"]);
  });
});

describe("inline checks on a secret field (FR-040)", () => {
  it("secret runs the field check on the cleaned value, and shows its refusal without the value", async () => {
    const { hub, prompter } = setup();
    const answer = prompter.secret("Slack bot token", { flag: "--slack-bot-token", validate: fieldCheck(checkSlackBotToken) });
    const refusal = post(hub, "xoxp-9999-USERtokenVALUE");
    expect(refusal).toBe("that is a user token (xoxp-); paste the Bot User OAuth Token from OAuth & Permissions, which starts with xoxb-");
    expect(JSON.stringify(hub.snapshot())).not.toContain("USERtokenVALUE");
    // Review Focus 3: a paste with markers and a trailing newline is cleaned before the check.
    expect(post(hub, "\u001b[200~xoxb-1111-2222-SECRETbotTOKENvalue\u001b[201~\n")).toBeUndefined();
    await expect(answer).resolves.toBe("xoxb-1111-2222-SECRETbotTOKENvalue");
  });
});
