import { DEVELOPER_FAILURE_MESSAGE_MAX, redactSecrets, redactText, type ProjectCommand } from "@agentx/contracts";
import type { CommandResult } from "./readiness.js";
import { MAX_COMMAND_OUTPUT_BYTES, redactedTail, withoutSplitPair } from "./collected-process.js";

/** #154: how much of the command, and of its error output, a failure message shows. */
export const COMMAND_SHOWN_MAX = 120;
const CWD_SHOWN_MAX = 80;
const TAIL_LINES = 20;
const TAIL_HEADING = "\nLast lines:\n";

export type CommandStage = "setup step" | "readiness check";

/**
 * Says which setup step or readiness check failed, and why (#154): its command (redacted and
 * capped), its directory, whether it timed out, was killed or exited, and the last lines of its
 * error output. Everything shown is redacted first and cut afterward, so a secret that straddles a
 * cut cannot leave a fragment that no longer matches its pattern. The message fits the developer
 * task view's failure message (DEVELOPER_FAILURE_MESSAGE_MAX), so that cap never cuts the tail.
 */
export function describeCommandFailure(
  stage: CommandStage,
  index: number,
  command: ProjectCommand,
  result: CommandResult,
  suffix = "",
): string {
  const how = result.timedOut === true
    ? `timed out after ${command.timeoutSeconds} s`
    : result.signal !== undefined
      ? `was killed by ${result.signal}`
      : result.exitCode >= 0
        ? `exited ${result.exitCode}`
        : "could not run";
  const head = `${stage} ${index} (${shownCommand(command)} in ${cut(redactText(command.cwd), CWD_SHOWN_MAX)}) ${how}${suffix}`;
  const tail = lastLines(redactText(result.stderr), DEVELOPER_FAILURE_MESSAGE_MAX - head.length - TAIL_HEADING.length);
  return tail === "" ? head : `${head}${TAIL_HEADING}${tail}`;
}

/** The executable and its arguments, redacted as an argv array (so `--token x` hides x) and as text. */
function shownCommand(command: ProjectCommand): string {
  const argv = redactSecrets([command.executable, ...command.args]) as unknown[];
  return cut(redactText(argv.map(String).join(" ").replace(/\s+/g, " ").trim()), COMMAND_SHOWN_MAX);
}

function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${withoutSplitPair(text.slice(0, limit - 3), "end")}...`;
}

/** The last TAIL_LINES non-blank lines, then at most `limit` characters from their end. */
function lastLines(text: string, limit: number): string {
  if (limit <= 0) return "";
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line !== "").slice(-TAIL_LINES);
  const joined = lines.join("\n");
  if (joined.length <= limit) return joined;
  return withoutSplitPair(joined.slice(joined.length - limit), "start");
}

/**
 * A command's output as the worker stores it (#170): redacted first, then cut to at most its last
 * `limit` bytes (so also characters), from a whole line, so a secret straddling the cut leaves no fragment behind.
 */
export function storedCommandOutput(text: string, limit = MAX_COMMAND_OUTPUT_BYTES): string {
  return redactedTail(text, limit);
}
