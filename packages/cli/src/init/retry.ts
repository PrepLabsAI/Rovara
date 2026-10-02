// packages/cli/src/init/retry.ts
// Q7 (FR-023, FR-041, FR-051): a check that fails while someone watches the install page asks to
// be run again, and runs again on yes. Without a page (the terminal path, --yes) it fails exactly
// as it always has, asking nothing, so the terminal's questions and errors stay as they are.
import { cliErrorFor } from "../deploy/commands.js";
import type { InstallSurface } from "./context.js";
import { messageWithoutCode, type Prompter } from "./prompts.js";
import { markOperatorStop } from "./stop.js";

/** The error's own words for a card: mapped as the rest of the CLI maps it (an expired AWS
 * session reads as one), without an AgentXError's "CODE: " prefix. */
export function problemText(error: unknown): string {
  const mapped = cliErrorFor(error);
  return mapped instanceof Error ? messageWithoutCode(mapped) : String(mapped);
}

export async function retryOnPage<T>(input: {
  surface: InstallSurface | undefined;
  prompter: Prompter;
  /** Asked after a failure, for example "Check the prerequisites again?". Yes is the default. */
  question: string;
  run: () => Promise<T>;
  /** Shows the failure on the page (a card) before the question. */
  failed: (problem: string) => void;
}): Promise<T> {
  for (;;) {
    try {
      return await input.run();
    } catch (error) {
      if (input.surface === undefined) throw error;
      input.failed(problemText(error));
      if (!(await input.prompter.confirm(input.question, { defaultValue: true }))) throw markOperatorStop(error);
    }
  }
}
