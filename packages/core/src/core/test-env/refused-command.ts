// A command the broker will not carry in a draft, a proposal or a seed: it fetches code and runs it, or its text changes under the redactor (a secret-shaped value). A leaf module, so the places that need it (the
// draft, the edit check, the approval's refusal of unsafe dependency seeds) can share it without importing each other.
import { formatCommandLine, looksLikeSecretValue, redactText, remoteCodeReason, reservedDependencyEnvName, type ProjectCommand, type TestEnvDependency } from "@rovara-code/contracts";

export function refusedCommand(command: ProjectCommand): boolean {
  const text = formatCommandLine(command);
  return remoteCodeReason(text) !== undefined || redactText(text) !== text;
}

/** The seed COMMANDS of a list of dependencies (a seed that is a repository file is not a command). */
export function dependencySeedCommands(dependencies: readonly Pick<TestEnvDependency, "seeds">[] | undefined): ProjectCommand[] {
  return (dependencies ?? []).flatMap((dependency) => dependency.seeds.flatMap((seed) => ("command" in seed ? [seed.command] : [])));
}

/** The most characters of a seed command (its line as shown to the approver) a proposal may hold. A longer one is refused, never cut: the approver must always see the whole command. */
export const SEED_COMMAND_DISPLAY_MAX = 2_000;

export type SeedCommandProblem = "remote_code_or_secret" | "env" | "too_long";

/** Whether an env value of a seed command is acceptable: no download-and-run text, nothing the redactor would change, nothing secret-shaped. */
const envValueRefused = (value: string): boolean => remoteCodeReason(value) !== undefined || redactText(value) !== value || looksLikeSecretValue(value);

/**
 * Why a seed command may not be carried, or undefined. A seed runs with the dependency's network access, so it gets every refusal a command gets (a download-and-run, a secret), plus: an env name the system or Rovara
 * owns (`LD_PRELOAD`, `NODE_OPTIONS`, `PATH`, ...), an env value that is a secret or a download-and-run, and a line longer than `SEED_COMMAND_DISPLAY_MAX`.
 */
export function seedCommandProblem(command: ProjectCommand): SeedCommandProblem | undefined {
  if (refusedCommand(command)) return "remote_code_or_secret";
  for (const [name, value] of Object.entries(command.env ?? {})) if (reservedDependencyEnvName(name) || envValueRefused(value)) return "env";
  // What the approver reads of the command: its directory, its words and the environment as shown.
  return command.cwd.length + formatCommandLine(command).length + (seedEnvWords(command)?.length ?? 0) > SEED_COMMAND_DISPLAY_MAX ? "too_long" : undefined;
}

/** The words for a refused seed command (fixed). */
export const SEED_COMMAND_PROBLEM_WORDS: Record<SeedCommandProblem, string> = {
  remote_code_or_secret: "a seed command downloads and runs code, or holds something secret",
  env: "a seed command sets an environment variable that the system owns, or holds something secret or a download-and-run in its value",
  too_long: `a seed command is longer than ${String(SEED_COMMAND_DISPLAY_MAX)} characters, so the approver could not see all of it`,
};

/** How a seed command's environment is shown: the names, and a value only when it is a plain literal (not secret-shaped, unchanged by the redactor, short); otherwise `(hidden)`. */
export function seedEnvWords(command: ProjectCommand): string | undefined {
  const entries = Object.entries(command.env ?? {});
  if (entries.length === 0) return undefined;
  return entries.map(([name, value]) => (value.length <= 200 && !envValueRefused(value) && !/[\p{Cc}\p{Cf}]/u.test(value) ? `${name}=${value}` : `${name}=(hidden)`)).join(" ");
}
