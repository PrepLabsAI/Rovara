// How a project's repository and its typed setup and test commands become a project definition: shared by the CLI's
// `project add` and the control plane's project creation for a cloud org, so both read a command the same way.
import { agentXError } from "./errors.js";
import type { ProjectCommand } from "./project-node.js";

/** The orchestrator instructions of a project registered by `project add` or created by a cloud org. */
export const DEFAULT_ORCHESTRATOR_INSTRUCTIONS = "Delegate every repository read, edit, build, and test to the remote AgentX worker.";
/** Seconds a setup command may run (the proposal's and a typed command's alike). */
export const SETUP_TIMEOUT = 900;
/** Seconds a test (readiness) command may run. */
export const TEST_TIMEOUT = 1800;
export function agentxRepositoryName(githubName: string): string {
  const cleaned = githubName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  return /^[a-z]/.test(cleaned) ? cleaned : `repo-${cleaned}`.slice(0, 63);
}

export function parseCommandLine(line: string, cwd: string, timeoutSeconds: number): ProjectCommand {
  const words: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  for (const character of line.trim()) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined; else current += character;
    } else if (character === '"' || character === "'") {
      quote = character; started = true;
    } else if (/\s/.test(character)) {
      if (started) { words.push(current); current = ""; started = false; }
    } else {
      current += character; started = true;
    }
  }
  if (quote !== undefined) throw agentXError("CONFIG_INVALID", "the command has an unclosed quote");
  if (started) words.push(current);
  if (words.length === 0) throw agentXError("CONFIG_INVALID", "the command is empty");
  if (words.some((word) => ["&&", "||", "|", ";"].includes(word))) {
    throw agentXError("CONFIG_INVALID", "a command runs one program; put && , | and ; steps in a script or Makefile target and call that");
  }
  const [executable, ...args] = words as [string, ...string[]];
  return { cwd, executable, args, timeoutSeconds };
}

const SHELL_SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX single-quote escaping: a quote inside the word closes the quotes, is written inside double quotes, and reopens them. */
function quoteWord(word: string): string {
  return SHELL_SAFE_WORD.test(word) ? word : `'${word.split("'").join(`'"'"'`)}'`;
}

/**
 * A command as one line, quoting a word only where it needs it, so `parseCommandLine` reads it back to the same executable and
 * arguments (it joins adjacent quoted pieces into one word, as a POSIX shell does).
 */
export function formatCommandLine(command: ProjectCommand): string {
  return [command.executable, ...command.args].map(quoteWord).join(" ");
}

/**
 * Per-line options survive an edit of another line. A settings save, and the candidate check that proves it, hold commands as lines; a line carries no timeout or env, so a line that reads back as exactly one of the
 * STORED commands (same program and arguments) is that stored command, options and directory included. Matched in order, each stored command used once (so a reorder, a deletion or a repeated line keeps each
 * command's own options). Any other line stays as parsed: its defaults. Pure; the same function for the save and for the check, so what is proved is what is written.
 */
export function keepStoredOptions(commands: readonly ProjectCommand[], stored: readonly ProjectCommand[]): ProjectCommand[] {
  const used = new Set<number>();
  return commands.map((command) => {
    const line = formatCommandLine(command);
    const at = stored.findIndex((candidate, index) => !used.has(index) && formatCommandLine(candidate) === line);
    if (at < 0) return command;
    used.add(at);
    return { ...stored[at]!, args: [...stored[at]!.args], ...(stored[at]!.env === undefined ? {} : { env: { ...stored[at]!.env } }) };
  });
}
