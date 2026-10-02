// Issue #235: Ctrl-C at a terminal question is a stop the person chose, not an internal error.
import { AgentXError } from "@agentx/contracts";

/** A stop the person made: printed as its one plain line, with exit code 130 (the shell's for Ctrl-C). */
export class StoppedByOperator extends Error {
  readonly exitCode = 130;
  constructor(message: string) {
    super(message);
    this.name = "StoppedByOperator";
  }
}

/**
 * True for Ctrl-C at a terminal question, or an error caused by one: Node's readline/promises
 * rejects the question with an AbortError ("Aborted with Ctrl+C"), and the hidden prompt
 * (init/prompts.ts readHidden) with CONFIG_INVALID "cancelled".
 */
export function isCtrlCAtPrompt(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 10; current = current.cause, depth += 1) {
    if (current.name === "AbortError" && /Ctrl\+C/.test(current.message)) return true;
    if (current instanceof AgentXError && current.code === "CONFIG_INVALID" && current.message.replace(/^CONFIG_INVALID: /, "") === "cancelled") return true;
  }
  return false;
}
