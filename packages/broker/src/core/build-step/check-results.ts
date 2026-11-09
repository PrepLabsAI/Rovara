// Lane L10, the build step: reading the worker's check report. Copied from Cloud's `terminal-result.ts` (`checkCommandCouldNotRun`, `regressedCheckLabels`); nothing here names a provider.
import { posix as posixPath } from "node:path";
import { WORKFLOW_REGRESSED_CHECKS_MAX, WORKFLOW_REGRESSED_CHECK_MAX, redactText, type CheckEntry } from "@agentx/contracts";

/**
 * Whether a failed check's command could not run, so the code is not what failed: the shell could not find it or run it
 * (exit 126 or 127), or the Python code the check itself is made of (its `-c` text, or its script) does not parse. A
 * syntax error in any other file, such as a module the check imports, is the change's own failure. A worker that sends
 * no exit code is judged by its output alone. A program the worker could not start is told apart by the caller.
 */
export function checkCommandCouldNotRun(command: { executable: string; args: readonly string[]; cwd: string }, exitCode: number | null | undefined, output: string): boolean {
  if (exitCode === 126 || exitCode === 127) return true;
  const program = command.executable.split("/").at(-1) ?? command.executable;
  if (!/^python(3(\..*)?)?$/u.test(program)) return false;
  const error = /^(SyntaxError|IndentationError):/mu.exec(output);
  if (error === null) return false;
  // The file the traceback names last before the error is the one that does not parse.
  const files = [...output.slice(0, error.index).matchAll(/^\s*File "([^"\n]*)", line \d+/gmu)];
  const file = files.at(-1)?.[1];
  const own = pythonCheckOwnCode(command.args);
  return file !== undefined && own !== undefined && (own === "<string>" ? file === "<string>" : pythonFileIsScript(file, own, command.cwd));
}

/** What a python check runs: `<string>` for `-c`, the script's path, or nothing the check owns (`-m module`, no script). */
function pythonCheckOwnCode(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "-c") return "<string>";
    if (arg === "-m") return undefined;
    if (arg === "-W" || arg === "-X") index += 1;
    else if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

/**
 * Whether a traceback's file is the check's own script: the same file once both are resolved against the check's
 * directory. A relative path is taken from the check's directory (or, in full, from the worker's root); an absolute one
 * must end with the script's path under the check's directory. A file elsewhere that only shares the script's name is
 * not the script: it is the change's own code.
 */
function pythonFileIsScript(file: string, script: string, cwd: string): boolean {
  const own = script.startsWith("/") ? posixPath.normalize(script) : posixPath.join(cwd, script);
  if (file.startsWith("/")) return script.startsWith("/") ? posixPath.normalize(file) === own : posixPath.normalize(file).endsWith(`/${own}`);
  return posixPath.join(cwd, file) === own || posixPath.normalize(file) === own;
}

/**
 * The tests a rerun found passed before this change and fail now: each label (a command, untrusted worker output) on one
 * line, redacted and cut short, without repeats, at most WORKFLOW_REGRESSED_CHECKS_MAX.
 */

export function regressedCheckLabels(entries: readonly CheckEntry[]): string[] {
  const labels = entries.filter((entry) => entry.class === "regression").map((entry) => {
    const line = redactText(entry.label).replace(/\s+/gu, " ").trim();
    return line.length > WORKFLOW_REGRESSED_CHECK_MAX ? `${line.slice(0, WORKFLOW_REGRESSED_CHECK_MAX - 3).trimEnd()}...` : line;
  }).filter((label) => label !== "");
  return [...new Set(labels)].slice(0, WORKFLOW_REGRESSED_CHECKS_MAX);
}
