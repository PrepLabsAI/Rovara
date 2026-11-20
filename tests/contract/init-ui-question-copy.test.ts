// Spec 048 FR-010 and FR-011: every question on the page has a label, one line on why it is
// asked, an example where one helps, the default it takes, and verb buttons. The terminal keeps
// its own words.
import { describe, expect, it } from "vitest";
import { browserPrompter } from "../../packages/cli/src/init/ui/prompter.js";
import { ALERT_FLAG, QUESTION_COPY, questionHelp } from "../../packages/cli/src/init/ui/question-copy.js";
import type { QuestionHelp } from "../../packages/cli/src/init/prompts.js";
import { lintCopy, type CopyEntry } from "../support/copy-lint.js";
import { createWizardHub, type WizardHub } from "../../packages/cli/src/init/ui/state.js";

const shown = (hub: WizardHub) => {
  const question = hub.state().question;
  if (question === undefined) throw new Error("no question shown");
  return question;
};

/** The default path's questions, as init asks them: kind, flag, and the terminal's own text. */
const DEFAULT_PATH: Array<[kind: "ask" | "choose" | "confirm" | "secret", flag: string | undefined, text: string]> = [
  ["choose", "AWS_PROFILE", "AWS profile"],
  ["choose", "--region", "AWS region"],
  // Spec 048 FR-020: the settings form's fields that are new in phase 2.
  ["ask", "--admin-email", "Your email, for your AgentX admin user and alerts"],
  ["ask", "--env", "Install name"],
  ["ask", "--github-app-name", "App name for GitHub and Slack (unique on GitHub)"],
  ["choose", "--worker-model", "Worker model"],
  ["choose", "--engine", "Deploy engine"],
  ["choose", "--identity", "Sign-in"],
  ["choose", "--model-provider", "Model provider"],
  ["choose", "--orchestrator-model", "Orchestrator model"],
  ["choose", "--classifier-model", "Action-gate classifier model"],
  ["ask", "--worker-model", "Worker model id"],
  ["ask", "--permission-boundary", "Permission boundary policy ARN (Enter for AgentX's default boundary)"],
  ["ask", "--operator-principal", "IAM principal allowed to assume the AgentX operator role (Enter for this account)"],
  ["choose", ALERT_FLAG, "Where should AgentX send alerts?"],
  ["ask", ALERT_FLAG, "Alert email address"],
  ["ask", "--budget", "Monthly AWS budget for this environment, in US dollars (0 for none; empty for the estimate plus 20%, $260)"],
  ["choose", "--budget-scope", "Which costs should the budget count?"],
  ["ask", "--github-account", "GitHub organization or user that will own the AgentX GitHub App"],
  ["choose", "--github-account-type", "Is acme an organization or a personal account?"],
  ["ask", "--github-app-name", "GitHub App name (must be unique on GitHub)"],
  ["ask", "--slack-app-name", "Slack app name"],
  ["choose", "--slack-app-posted-messages", "Answer mentions people post through other apps with their own Slack token?"],
  ["confirm", undefined, "Create all of this?"],
  ["choose", "--plan", "Create all of this?"],
  ["choose", "--slack-install", "Is the Slack app installed in your workspace?"],
  ["secret", "--slack-bot-token", "Slack bot token"],
  ["secret", "--slack-signing-secret", "Slack signing secret"],
  ["confirm", undefined, "Is this the AgentX bot in the right workspace?"],
  ["confirm", undefined, "Does Slack show the Request URL as Verified?"],
  ["choose", "--signin", "How will developers sign in to AgentX from their AI tools?"],
  ["ask", "--slack-client-id", "Slack app Client ID (Basic Information, App Credentials)"],
  ["secret", "--slack-client-secret", "Slack client secret"],
  ["confirm", undefined, "Apply this change?"],
  ["ask", "--admin-email", "Your email address, for your AgentX admin user"],
  ["choose", "--repository", "Which repository is the first project's?"],
  ["ask", "--project-name", "Project name"],
  ["confirm", undefined, "Use these commands? (npm ci, npm test)"],
  ["ask", "--channel", "Which Slack channel should the project use?"],
  ["confirm", undefined, "Connect Linear to payments-api now? (You can add it later with agentx connector add linear)"],
  ["confirm", undefined, "Did a test alarm named agentx-staging-test arrive at ops@example.com?"],
  ["confirm", undefined, "Check the prerequisites again?"],
  ["confirm", undefined, "Paste the Slack values again?"],
  ["confirm", undefined, "Run the Request URL check again?"],
  ["confirm", undefined, "Sign in again?"],
  ["confirm", undefined, "Watch for the reply again?"],
  ["confirm", undefined, "Have you confirmed the subscription? Answer Yes to check again."],
];

describe("the page's words for each question", () => {
  for (const [kind, flag, text] of DEFAULT_PATH) {
    it(`FR-010: "${text}" has a label and a why line${kind === "confirm" ? ", and verb buttons" : ""}`, () => {
      const help = questionHelp({ kind, text, ...(flag === undefined ? {} : { flag }) });
      expect(help.label).toMatch(/\S/);
      expect(help.why).toMatch(/\S/);
      if (kind === "confirm") {
        expect(help.yesLabel).toMatch(/\S/);
        expect(help.noLabel).toMatch(/\S/);
        expect([help.yesLabel, help.noLabel]).not.toContain("Yes");
        expect([help.yesLabel, help.noLabel]).not.toContain("No");
      }
    });
  }

  // FR-081: every source of page text is linted, not only the entries a driven journey reaches.
  it("FR-081: every catalog entry's words pass the copy lint", () => {
    const entries: CopyEntry[] = QUESTION_COPY.flatMap((entry, index): CopyEntry[] => {
      let help: QuestionHelp;
      if (typeof entry.help === "function") {
        // A sample match: the default path's own text for this entry.
        const sample = DEFAULT_PATH.map(([, , text]) => (entry.text === undefined ? null : entry.text.exec(text))).find((found) => found !== null);
        if (sample === undefined || sample === null) throw new Error(`no sample text for catalog entry ${index}`);
        help = entry.help(sample);
      } else {
        help = entry.help;
      }
      const texts = [help.label, help.why, help.example, help.hint, help.defaultText, help.yesLabel, help.noLabel, ...Object.values(help.choiceLabels ?? {})];
      return texts.filter((text): text is string => text !== undefined).map((text) => ({ where: `catalog entry ${index} (${entry.kind} ${entry.flag ?? String(entry.text)})`, text, context: "page" }));
    });
    expect(entries.length).toBeGreaterThan(150);
    expect(lintCopy(entries)).toEqual([]);
  });

});

describe("browserPrompter with help", () => {

  it("a choose with buttons is an actions question, and only its choices are accepted", async () => {
    const hub = createWizardHub("staging");
    const answer = browserPrompter(hub).choose("Your AWS sign-in is missing or has expired. What next?", [
      { value: "signin", label: "Sign in (aws sso login --profile dev)" }, { value: "retry", label: "check again" }, { value: "stop", label: "Stop the install" },
    ], { flag: "AWS_PROFILE", defaultValue: "signin" });
    expect(shown(hub)).toMatchObject({ kind: "actions" });
    expect(shown(hub).buttons).toEqual([
      { value: "signin", label: "Sign in again", primary: true },
      { value: "retry", label: "I signed in another way, check again", primary: false },
      { value: "stop", label: "Stop for now", primary: false },
    ]);
    expect(hub.answer(shown(hub).id, "nonsense")).toBe("choose one of the options");
    hub.answer(shown(hub).id, "stop");
    await expect(answer).resolves.toBe("stop");
  });

});
