// the commands a test-environment proposal would add to a project's settings, and the lists a candidate check therefore runs. Pure, and used by both sides of the apply: the candidate check is prepared
// from `candidateLists` (the settings' commands plus what the proposal adds), and the approval writes `commandsToApply` of the same proposal against the same settings. When the settings are the revision the
// check ran against, the two are the same lists, so what is written is exactly what was proved.
import { SETUP_TIMEOUT, TEST_TIMEOUT, agentXError, keepStoredOptions, type ProjectCommand, type TestEnvApplyAnswer, type TestEnvironmentBody } from "@agentx/contracts";
import { refusedCommand } from "./draft.js";
import { PROVED_CHECK_KINDS } from "./prove-from-setup-check.js";

export type Skipped = TestEnvApplyAnswer["skipped"][number];

export const sameCommand = (left: ProjectCommand, right: ProjectCommand): boolean => left.cwd === right.cwd && left.executable === right.executable && JSON.stringify(left.args) === JSON.stringify(right.args);
export const SETTINGS_COMMANDS_MAX = 16;

/** What a proposal adds to a project's commands, and what it leaves out and why. Pure: the project's settings save does the rest. */
export function commandsToApply(
  body: TestEnvironmentBody, current: { setup: readonly ProjectCommand[]; readiness: readonly ProjectCommand[] }, firstRepositoryPath: string,
  /** a proposal that REPLACES the lists (a person's typed commands): its commands are the whole lists, so nothing of the settings' is kept and a removal or a fix takes effect. */
  replace = false,
): { setup: ProjectCommand[]; readiness: ProjectCommand[]; skipped: Skipped[] } {
  if (replace) current = { setup: [], readiness: [] };
  const skipped = new Map<Skipped["reason"], number>();
  const skip = (reason: Skipped["reason"]) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  const wanted = (command: ProjectCommand, have: ProjectCommand[]): boolean => {
    if (refusedCommand(command)) { skip("download_and_run"); return false; }
    // The settings save runs every command in the project's first repository: a command for another directory can't be put there.
    if (command.cwd !== firstRepositoryPath) { skip("different_directory"); return false; }
    return !have.some((candidate) => sameCommand(candidate, command));
  };
  const setup = [...current.setup], readiness = [...current.readiness];
  const added = { setup: [] as ProjectCommand[], readiness: [] as ProjectCommand[] };
  const add = (target: ProjectCommand[], fresh: ProjectCommand[], command: ProjectCommand) => {
    if (!wanted(command, target)) return;
    if (target.length >= SETTINGS_COMMANDS_MAX) { skip("too_many"); return; }
    target.push(command); fresh.push(command);
  };
  for (const repo of body.repos) {
    for (const command of repo.setupCommands) add(setup, added.setup, command);
    for (const check of repo.checks) {
      if (!PROVED_CHECK_KINDS.includes(check.kind)) { skip("not_needed"); continue; }
      add(readiness, added.readiness, check.command);
    }
  }
  return { setup: added.setup, readiness: added.readiness, skipped: [...skipped].map(([reason, count]) => ({ reason, count })) };
}

/**
 * A command in the form the settings save stores a NEW line: the save writes each command as a line and reads it back, so a command's own `env` is dropped and its timeout becomes the list's (900 s for setup,
 * 1800 s for tests). A line that is already one of the stored commands is that stored command (see `keepStoredOptions`), so the save keeps its own timeout and env.
 */
export const asSaved = (command: ProjectCommand, timeoutSeconds: number): ProjectCommand => ({ cwd: command.cwd, executable: command.executable, args: [...command.args], timeoutSeconds });

/**
 * The lists the settings would hold once the proposal's commands are added: what the candidate check runs, and what an approval writes. The save reads every line against the stored commands: a line that is one of
 * them keeps its stored timeout, env and directory (so editing one command leaves the others as they are), any other line comes back in the saved form. A list the proposal adds nothing to is left exactly as stored.
 * The check runs this form, so what it proves is what is written.
 */
export function candidateLists(body: TestEnvironmentBody, current: { setup: readonly ProjectCommand[]; readiness: readonly ProjectCommand[] }, firstRepositoryPath: string, replace = false): { setup: ProjectCommand[]; readiness: ProjectCommand[] } {
  const plan = commandsToApply(body, current, firstRepositoryPath, replace);
  // A replacing proposal: exactly its own commands (an empty list stays empty); each one that is a stored command keeps that command's options.
  if (replace) return { setup: keepStoredOptions(plan.setup.map((command) => asSaved(command, SETUP_TIMEOUT)), current.setup), readiness: keepStoredOptions(plan.readiness.map((command) => asSaved(command, TEST_TIMEOUT)), current.readiness) };
  // Stored commands stay as stored; only the added ones are put in the saved form.
  const list = (stored: readonly ProjectCommand[], added: readonly ProjectCommand[], timeoutSeconds: number): ProjectCommand[] =>
    added.length === 0 ? [...stored] : [...stored, ...added.map((command) => asSaved(command, timeoutSeconds))];
  return { setup: list(current.setup, plan.setup, SETUP_TIMEOUT), readiness: list(current.readiness, plan.readiness, TEST_TIMEOUT) };
}

/** How many of an environment's commands the save would still add to the settings (not those it never adds: another directory, downloaded code, too many, not a build, smoke or test check). */
export function commandsMissingFromSettings(
  body: TestEnvironmentBody, definition: { repositories: ReadonlyArray<{ path: string }>; setup: readonly ProjectCommand[]; readiness: readonly ProjectCommand[] },
): number {
  const first = definition.repositories[0]?.path;
  if (first === undefined) return 0;
  const plan = commandsToApply(body, definition, first);
  return plan.setup.length + plan.readiness.length;
}

/** Whether two command lists are the same commands in the same order. */
export const sameCommands = (left: readonly ProjectCommand[], right: readonly ProjectCommand[]): boolean => left.length === right.length && left.every((command, index) => sameCommand(command, right[index]!));

/** What a refusal says when the project's commands run in more than one directory (the settings save puts every command in the first repository's directory). */
export const ONE_DIRECTORY_WORDS = "The project's commands run in more than one directory, so they can't be changed from here. Ask an administrator.";

/**
 * The lists a candidate check runs for `body` against a project's latest definition, under the settings save's own rule: every command runs in the project's first repository, so a project whose commands already
 * run elsewhere (or that has no repository) is refused, as the apply refuses it.
 */
export function candidateListsChecked(
  body: TestEnvironmentBody, definition: { repositories: ReadonlyArray<{ path: string }>; setup: readonly ProjectCommand[]; readiness: readonly ProjectCommand[] }, replace = false,
): { setup: ProjectCommand[]; readiness: ProjectCommand[] } {
  const first = definition.repositories[0]?.path;
  if (first === undefined || [...definition.setup, ...definition.readiness].some((command) => command.cwd !== first)) throw agentXError("CONFIG_INVALID", ONE_DIRECTORY_WORDS);
  return candidateLists(body, definition, first, replace);
}


/** Whether two command lists are identical: every field, env and timeout included (the check's record against what the save would store). */
export const identicalCommands = (left: readonly ProjectCommand[], right: readonly ProjectCommand[]): boolean => left.length === right.length && left.every((command, index) => JSON.stringify(command) === JSON.stringify(right[index]));
