// Seed commands in a setup draft: the worker reports a command that fills or migrates a database in the draft as `seedCommands`, and leaves every setup command where it was (setup has no database, but the
// worker cannot know whether a database will be proposed). The BROKER decides where it lands: the seed of the first database dependency it proposes (real software or Rovara local AWS, never a fake), after the same
// refusals a seed always gets (`seedCommandProblem`: download-and-run, secrets, system variables, length). ONLY a command the dependency actually took is taken out of the setup commands (`withoutRoutedSeeds`, and the draft's own setup commands in `draft.ts`); one that was refused, dropped (test services off) or had no database to go to stays a setup command. Nothing here approves anything: a seed
// command is a less-safe change (`dependency_seed`), so a second person still confirms it. Notes are fixed words, never the command.
import { formatCommandLine, parseCommandLine, TEST_ENV_DEPENDENCY_LIMITS, TestEnvDependenciesSchema, type ProjectCommand, type SetupProposal, type TestEnvDependency, type TestEnvDraft } from "@agentx/contracts";
import { seedCommandProblem } from "./refused-command.js";

export const SEED_OFFERED_NOTE = "A command that fills the database was found. It is offered as the test database's seed, not as a setup command: setup has no database. It runs where the project's own setup runs, with the same access (in the working phase it can reach the internet). When it is the repository's own seed script, unchanged, one maintainer can approve it; any other seed command, and any migrate command, needs a second person.";
export const SEED_NO_DATABASE_NOTE = "A command that fills the database was found, but no test database could be proposed for it, so it is not offered as a seed and stays where it was found. Add the database first.";
export const SEED_NOT_TAKEN_NOTE = "A command that fills the database was found, but the test database could not take it, so it is not offered as a seed and stays where it was found.";
export const SEED_LEFT_OUT_OF_SETUP_NOTE = "A command that fills the database was left out of the setup commands: the database exists only inside the test environment, so the command would fail in setup. It is offered as the test environment's seed instead.";
export const SEED_FILE_OFFERED_NOTE = "A file of test data was found and is offered as the test database's seed: it is SQL the test database's own client runs inside the sealed test database, as a role with no superuser rights; it cannot reach the network or your secrets. A command that fills the database was also found; it is not used, and is left out of setup (setup has no database). If the tests need it too, add it in the test data field (a seed command you type needs a second person).";
export const SEED_FILE_ONLY_NOTE = "A file of test data was found and is offered as the test database's seed: it is SQL the test database's own client runs inside the sealed test database, as a role with no superuser rights; it cannot reach the network or your secrets.";
export const SEED_REFUSED_NOTE = "A command that fills the database was left out: it downloads and runs code, holds something secret, or sets a variable the system owns.";

/**
 * The dependencies with the draft's seed commands on the first database one, the fixed notes for what happened, and `routed`: the commands the dependency actually took (none when it took nothing). A list the contract
 * would refuse is returned as it came. Never throws.
 */
export function attachDraftSeeds(dependencies: readonly TestEnvDependency[], seeds: TestEnvDraft["seedCommands"], files?: TestEnvDraft["seedFiles"]): { dependencies: TestEnvDependency[]; notes: string[]; routed: ProjectCommand[] } {
  // a seed FILE, where one was found, is preferred over a command (a file is SQL the database's own client runs, as a role with no superuser rights, in the sealed test database; a command runs the project's code).
  if (files !== undefined && files.length > 0) {
    const withFiles = attachSeedFiles(dependencies, files, seeds ?? []);
    if (withFiles !== undefined) return withFiles;
  }
  if (seeds === undefined || seeds.length === 0) return { dependencies: [...dependencies], notes: [], routed: [] };
  const notes: string[] = [];
  const allowed = seeds.filter((seed) => seedCommandProblem(seed.command) === undefined);
  if (allowed.length < seeds.length) notes.push(SEED_REFUSED_NOTE);
  if (allowed.length === 0) return { dependencies: [...dependencies], notes, routed: [] };
  const index = dependencies.findIndex((dependency) => dependency.kind === "database" && (dependency.backing.kind === "local" || dependency.backing.kind === "emulated"));
  if (index < 0) return { dependencies: [...dependencies], notes: [...notes, SEED_NO_DATABASE_NOTE], routed: [] };
  const target = dependencies[index]!;
  const held = target.seeds.filter((seed) => !("command" in seed));
  const taken = allowed.slice(0, Math.max(0, TEST_ENV_DEPENDENCY_LIMITS.seeds - held.length));
  const next: TestEnvDependency = { ...target, seeds: [...held, ...taken.map((seed) => ({ command: seed.command }))] };
  const list = dependencies.map((dependency, at) => (at === index ? next : dependency));
  if (taken.length === 0 || !TestEnvDependenciesSchema.safeParse(list).success) return { dependencies: [...dependencies], notes: [...notes, SEED_NOT_TAKEN_NOTE], routed: [] };
  return { dependencies: list, notes: [...notes, SEED_OFFERED_NOTE], routed: taken.map((seed) => seed.command) };
}

/**
 * The seed files on the first database dependency Rovara starts (real software only: the worker loads a file into Postgres), keeping what it already held, as `{ fixturePath }`. The draft's seed commands are then NOT
 * attached, and leave setup all the same (they need the database, which setup has not got); the note says so and where to add one back. Undefined when no such dependency takes the files (the commands are then
 * routed as before).
 */
function attachSeedFiles(dependencies: readonly TestEnvDependency[], files: NonNullable<TestEnvDraft["seedFiles"]>, seeds: NonNullable<TestEnvDraft["seedCommands"]>): { dependencies: TestEnvDependency[]; notes: string[]; routed: ProjectCommand[] } | undefined {
  const index = dependencies.findIndex((dependency) => dependency.kind === "database" && dependency.family === "postgres" && dependency.backing.kind === "local");
  if (index < 0) return undefined;
  const target = dependencies[index]!;
  const held = target.seeds.filter((seed) => !("command" in seed));
  const known = new Set(held.flatMap((seed) => ("fixturePath" in seed ? [seed.fixturePath] : [])));
  const added = files.filter((file) => !known.has(file.path)).slice(0, Math.max(0, TEST_ENV_DEPENDENCY_LIMITS.seeds - held.length)).map((file) => ({ fixturePath: file.path }));
  if (added.length === 0) return undefined;
  const list = dependencies.map((dependency, at) => (at === index ? { ...target, seeds: [...held, ...added] } : dependency));
  if (!TestEnvDependenciesSchema.safeParse(list).success) return undefined;
  const commands = seeds.filter((seed) => seedCommandProblem(seed.command) === undefined).map((seed) => seed.command);
  return { dependencies: list, notes: [commands.length > 0 ? SEED_FILE_OFFERED_NOTE : SEED_FILE_ONLY_NOTE], routed: commands };
}

/** Whether two commands are the same one: the same directory, program and words (the time limit does not make a command another). */
export const sameCommand = (left: ProjectCommand, right: ProjectCommand): boolean => left.cwd === right.cwd && formatCommandLine(left) === formatCommandLine(right);

/** A seed command a dependency took, and the repository whose setup it came from (the repository's id; none when no command of the environment runs in the command's directory). */
export interface RoutedSeed { command: ProjectCommand; repositoryId?: string | undefined }

/**
 * The setup proposal without the lines the dependency took as its seed, and nothing else: only in the repository the command was routed from (another repository's command with the same words stays, as it does in the
 * draft environment), and no other line. An item left with no command is removed; a fixed note says so once. The same proposal object is returned when nothing was taken. A command with no known repository is taken out nowhere.
 */
export function withoutRoutedSeeds(proposal: SetupProposal, routed: readonly RoutedSeed[]): SetupProposal {
  if (routed.length === 0) return proposal;
  const line = (text: string): string => { try { return formatCommandLine(parseCommandLine(text, ".", 900)); } catch { return text; } };
  const linesOf = (repo: string): Set<string> => new Set(routed.filter((seed) => seed.repositoryId === repo).map((seed) => formatCommandLine(seed.command)));
  let removed = false;
  const setup = proposal.setup.flatMap((item) => {
    const lines = linesOf(item.value.repo);
    if (lines.size === 0) return [item];
    const commands = item.value.commands.filter((text) => { const taken = lines.has(line(text)); removed ||= taken; return !taken; });
    return commands.length === 0 ? [] : [{ ...item, value: { ...item.value, commands } }];
  });
  if (!removed) return proposal;
  const notes = proposal.notes.includes(SEED_LEFT_OUT_OF_SETUP_NOTE) ? proposal.notes : [proposal.notes, SEED_LEFT_OUT_OF_SETUP_NOTE].filter((part) => part !== "").join(" ").slice(0, 2000);
  return { ...proposal, setup, notes };
}
