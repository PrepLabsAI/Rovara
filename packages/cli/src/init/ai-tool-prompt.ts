// packages/cli/src/init/ai-tool-prompt.ts
// Issue #1599: when an install finishes, the ready card and the terminal show a short block to paste
// into an AI tool, so a new session knows the install and where the docs are. It is built only from
// the install's name and region and the CLI's own invocation: it takes no secret, token, password or
// email, so it can never show one.
import { CLI_PACKAGE_NAME } from "@agentx/contracts";
import { cliCommandLine, type CliInvocation } from "./cli-command.js";

/** The heading shown above the block, on the page and in the terminal. */
export const AI_TOOL_PROMPT_LABEL = "Paste this into Claude Code, Codex or Cursor";

/** The CLI reference section on using an install from another computer. */
export const ANOTHER_COMPUTER_DOCS_URL = "https://github.com/PrepLabsAI/Rovara/blob/mainline/docs/cli-reference.md#use-an-existing-install-from-another-computer";

/** How the AI tool gets the CLI: the published package at this CLI's version, or this computer's
 * own copy when the CLI was built from source (no package to name, as cli-command.ts says). */
function cliSource(invocation: CliInvocation): string {
  if (invocation.published && invocation.version !== undefined) return `npm package ${invocation.packageName ?? CLI_PACKAGE_NAME}@${invocation.version}`;
  return `built from source; on this computer: ${cliCommandLine(invocation, "").trimEnd()}`;
}

/** The block to paste into an AI tool, filled in with this install's name and region. */
export function aiToolPrompt(input: { env: string; region: string; invocation: CliInvocation }): string {
  const { env, region } = input;
  return [
    `I run a self-hosted Rovara install named ${env} in AWS region ${region}.`,
    "Read https://rovara.dev/llms.txt, then help me manage it with the rovara CLI",
    `(${cliSource(input.invocation)}). Always pass --env ${env} --region ${region}.`,
    "To connect this computer, follow \"Use an existing install from another computer\" in the CLI reference:",
    ANOTHER_COMPUTER_DOCS_URL,
  ].join("\n");
}
