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

/**
 * The program a saved SHELL line is stored under: `bash -c <line>` (SETUP-L9-SHELL, DEC 254zzz562). A line that only names a program and its words ("npm ci") is stored as that program and its arguments, as it always was.
 * A line that needs a shell to mean what it says (`source .venv/bin/activate && pip install -r requirements.txt`, `cd sub && npm ci`, `FOO=1 make`, `pytest tests/*.py`) is stored as this one program with the line as its
 * single argument, so the stored shape, its schema, its digests and every older reader are unchanged. `shellLineOf` reads it back and `formatCommandLine` shows the bare line. The worker's one command runner (`runContainerCommand`)
 * runs EVERY saved command, shell or not, in a bash session (see worker/src/shell-session.ts).
 */
export const SHELL_PROGRAM = "bash";

/** Characters that mean something to a shell when they are not quoted: operators, redirections, groups, expansions, globs, escapes, comments. */
const SHELL_SPECIAL = new Set(["&", "|", ";", "<", ">", "(", ")", "{", "}", "$", "`", "\\", "*", "?", "[", "]", "!"]);
/** Words that are not programs: a shell builtin or keyword, which only a shell can run (and which only change the session when the session runs them). */
const SHELL_FIRST_WORDS: ReadonlySet<string> = new Set([
  "cd", "source", ".", "export", "unset", "set", "alias", "unalias", "eval", "exec", "ulimit", "umask", "hash", "declare", "local", "typeset", "readonly", "shift", "trap", "wait", "read", "return", "exit", "pushd", "popd",
  "dirs", "shopt", "builtin", "command", "type", "if", "for", "while", "until", "case", "function", "select", "[[", "!", "{", "}",
]);
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/u;

interface LineReading { words: string[]; shell: boolean; unclosedQuote: boolean }

/** What an unquoted character does to a line: a shell operator or expansion, or (at the start of a word) a comment or `~`. */
const specialOutsideQuotes = (character: string, atWordStart: boolean): boolean => SHELL_SPECIAL.has(character) || (atWordStart && (character === "#" || character === "~"));
/** Inside double quotes a shell still expands `$`, a back tick and a backslash; inside single quotes nothing. */
const specialInDoubleQuotes = (character: string): boolean => character === "$" || character === "`" || character === "\\";

/** Reads a line the way a POSIX shell splits it into words (quotes removed) and says whether it needs a shell to mean what it says. */
function readLine(line: string): LineReading {
  const words: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  let shell = false;
  let wordStart = true;
  for (const character of line.trim()) {
    if (quote !== undefined && character === quote) { quote = undefined; continue; }
    if (quote !== undefined) {
      current += character;
      shell ||= quote === '"' && specialInDoubleQuotes(character);
    } else if (character === '"' || character === "'") {
      [quote, started, wordStart] = [character, true, false];
    } else if (/\s/.test(character)) {
      if (started) { words.push(current); current = ""; started = false; }
      wordStart = true;
    } else {
      shell ||= specialOutsideQuotes(character, wordStart);
      current += character; started = true; wordStart = false;
    }
  }
  if (started) words.push(current);
  const first = words[0];
  shell ||= first !== undefined && (SHELL_FIRST_WORDS.has(first) || ASSIGNMENT_WORD.test(first));
  return { words, shell, unclosedQuote: quote !== undefined };
}

/** Whether a line needs a shell to mean what it says (an operator, a redirection, an expansion, a glob, a builtin such as `cd` or `source`, a `NAME=value` prefix). Pure; the same reading as `parseCommandLine`. */
export function needsShell(line: string): boolean {
  return readLine(line).shell;
}

/** The line a command runs as a SHELL line (stored as `bash -c <line>`), or undefined for a command that is one program and its arguments. */
export function shellLineOf(command: Pick<ProjectCommand, "executable" | "args">): string | undefined {
  const line = command.args[1];
  return command.executable === SHELL_PROGRAM && command.args.length === 2 && command.args[0] === "-c" && line !== undefined && line === line.trim() && needsShell(line) ? line : undefined;
}

export function parseCommandLine(line: string, cwd: string, timeoutSeconds: number): ProjectCommand {
  const text = line.trim();
  const { words, shell, unclosedQuote } = readLine(text);
  // A shell line may carry an escaped quote (`echo it\'s`), which only the shell can read; without a backslash an open quote is a mistake whatever the shell.
  if (unclosedQuote && !(shell && text.includes("\\"))) throw agentXError("CONFIG_INVALID", "the command has an unclosed quote");
  if (words.length === 0) throw agentXError("CONFIG_INVALID", "the command is empty");
  if (shell) {
    // One line, so the person who approves it reads all of it.
    if (/[\n\r]/u.test(text) || text.includes("\0")) throw agentXError("CONFIG_INVALID", "a command is one line");
    return { cwd, executable: SHELL_PROGRAM, args: ["-c", text], timeoutSeconds };
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
  // A shell line is shown, compared and checked as the line it is.
  const shell = shellLineOf(command);
  if (shell !== undefined) return shell;
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
