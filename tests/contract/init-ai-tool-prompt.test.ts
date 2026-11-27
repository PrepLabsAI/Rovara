// Issue #1599: when an install finishes, the ready card and the terminal show a block to paste into
// an AI tool, filled in with the install's name and region and holding no secret.
import { describe, expect, it } from "vitest";
import { AI_TOOL_PROMPT_LABEL, ANOTHER_COMPUTER_DOCS_URL, aiToolPrompt } from "../../packages/cli/src/init/ai-tool-prompt.js";
import { readyText } from "../../packages/cli/src/init/finish-steps.js";
import { emptyProgress, type InstallProgress } from "../../packages/cli/src/init/install-state.js";
import { readyCard } from "../../packages/cli/src/init/ui/cards.js";
import { lintCopy } from "../support/copy-lint.js";
import { TEST_BOT_TOKEN, TEST_SIGNING_SECRET } from "../support/init-fakes.js";

const PUBLISHED = { published: true, version: "1.2.3", cliPath: "/x/node_modules/@preplabsai/rovara-code/bin/agentx.mjs" };
const FROM_SOURCE = { published: false, cliPath: "/opt/agentx/dist/main.js" };

// The secret-like values a sample install had. None is an input of the prompt; the progress below
// carries the Slack IDs and names a finished install records.
const INSTALL_SECRETS = [
  TEST_BOT_TOKEN,
  TEST_SIGNING_SECRET,
  "sk-or-v1-feedface0123456789OPENROUTERSECRET",
  "sk-ant-api03-0123456789abcdefKEYSECRET",
  "Temporary-Passw0rd!",
  "admin@example.com",
  "ops@example.com",
  "123456789012",
];

const PROGRESS: InstallProgress = {
  ...emptyProgress("acme-prod", 0),
  slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT", botName: "rovara-acme" },
  project: { name: "payments-api", revision: 1, channelName: "payments", channelId: "C0PAY00001", teamId: "T0TEAM" },
};

const SAMPLE = { env: "acme-prod", region: "eu-west-1", controlPlaneUrl: "https://abc.example.com", progress: PROGRESS, botName: "rovara-acme" };

describe("the prompt for an AI tool", () => {

  it("names the install, its region, the docs and the published package at this CLI's version", () => {
    expect(aiToolPrompt({ env: "acme-prod", region: "eu-west-1", invocation: PUBLISHED })).toBe([
      "I run a self-hosted Rovara install named acme-prod in AWS region eu-west-1.",
      "Read https://rovara.dev/llms.txt, then help me manage it with the rovara CLI",
      "(npm package @preplabsai/rovara-code@1.2.3). Always pass --env acme-prod --region eu-west-1.",
      "To connect this computer, follow \"Use an existing install from another computer\" in the CLI reference:",
      "https://github.com/PrepLabsAI/Rovara/blob/mainline/docs/cli-reference.md#use-an-existing-install-from-another-computer",
    ].join("\n"));
    expect(ANOTHER_COMPUTER_DOCS_URL).toMatch(/^https:\/\/github\.com\/PrepLabsAI\/Rovara\/blob\/mainline\/docs\/cli-reference\.md#/u);
  });

  it("names this computer's own copy, not the package, when the CLI was built from source", () => {
    const prompt = aiToolPrompt({ env: "acme-prod", region: "eu-west-1", invocation: FROM_SOURCE });
    expect(prompt).toContain("(built from source; on this computer: node /opt/agentx/dist/main.js). Always pass --env acme-prod --region eu-west-1.");
    expect(prompt).not.toContain("@preplabsai/rovara-code");
  });

  it("is on the ready card with its heading, with the install's name and region and no secret", () => {
    const card = readyCard({ ...SAMPLE, invocation: PUBLISHED, root: false, alertsOn: true, created: [] });
    expect(card.prompt).toEqual({ label: AI_TOOL_PROMPT_LABEL, text: aiToolPrompt({ env: "acme-prod", region: "eu-west-1", invocation: PUBLISHED }) });
    expect(AI_TOOL_PROMPT_LABEL).toBe("Paste this into Claude Code, Codex or Cursor");
    const text = card.prompt?.text ?? "";
    expect(text).toContain("acme-prod");
    expect(text).toContain("eu-west-1");
    for (const secret of INSTALL_SECRETS) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/\bxox[abp]-|\bsk-|password|@[a-z0-9-]+\.[a-z]{2,}/iu);
    // The page's copy rules (FR-081) hold for the prompt too.
    expect(lintCopy([{ where: "ready prompt", text, context: "ready" }, { where: "ready prompt", text: AI_TOOL_PROMPT_LABEL, context: "ready" }])).toEqual([]);
  });

  it("ends the terminal's ready text, after the is-ready line", () => {
    const text = readyText({ ...SAMPLE, invocation: FROM_SOURCE });
    expect(text.startsWith("AgentX environment acme-prod is ready.\n")).toBe(true);
    expect(text.endsWith(`\n\n${AI_TOOL_PROMPT_LABEL}:\n${aiToolPrompt({ env: "acme-prod", region: "eu-west-1", invocation: FROM_SOURCE })}`)).toBe(true);
    for (const secret of INSTALL_SECRETS) expect(text).not.toContain(secret);
  });

});
