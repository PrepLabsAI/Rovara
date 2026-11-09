// Seed and migration commands (TS-UX-1): a command that fills or builds a database. Such a command needs a database, and a project's database exists only inside the test environment (the test services start it for a
// run), so it is never a SETUP command: setup runs on a fresh machine with no database, and the command is bound to fail. It belongs to the dependency's seed. This is a reading of the command's words, nothing more:
// it never runs anything, and a person still approves where a command lands.
import type { ProjectCommand } from "./project-node.js";

/** Programs that run a project's own script or tool. Anything else (`git`, `cat`) is never read as a seed. */
const RUNNERS = new Set([
  "npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx", "node", "ts-node", "tsx", "deno", "python", "python3", "poetry", "pipenv", "uv", "flask", "django-admin", "alembic", "rake", "rails", "bundle", "make", "psql", "pg_restore", "knex", "sequelize", "prisma", "typeorm", "drizzle-kit",
]);
/** The words that say a command seeds or migrates a database. */
const VERBS = new Set(["seed", "seeds", "seeding", "migrate", "migration", "migrations", "loaddata"]);
/** Words that may sit beside a verb in one name (`db:seed`, `seed_db`, `seed:test`, `db-migrate`) without changing what it is. Any other word (`migrate-assets`, `tsconfig.migrations`) makes it something else. */
const QUALIFIERS = new Set(["db", "database", "data", "test", "tests", "dev", "local", "run", "all", "up", "down", "schema", "sql", "deploy", "fixtures", "replant", "load", "reset", "setup", "create", "push",
  "latest", "rollback", "status", "fresh", "prod", "production", "ci", "e2e", "staging", "users", "prisma", "drizzle", "typeorm", "knex", "sequelize"]);
/** A name that is a whole command word of its own, not made of parts: `rails db:setup`. */
const EXTRA_WORDS = new Set(["db:setup", "db:reset", "db:push", "db:schema:load", "db:create", "db-setup", "db-reset"]);
/** A path counts only when it ends in a script file (`scripts/seed.js`); a directory or a config file that has the word in its name (`packages/migrations`, `tsconfig.migrations.json`) is not a seed. */
const SCRIPT_EXTENSION = /\.(?:[cm]?[jt]s|py|rb|sh|sql)$/u;
/** A directory that holds a project's migrations or seeds: a script run from there (`node src/db/migrations/run.js`) is one, if its own name is a generic one (`run`, `index`, not `build`). */
const SEED_DIRECTORIES = new Set(["migrations", "migration", "seeds", "seeders", "seed"]);
const GENERIC_SCRIPT_NAMES = new Set(["index", "main", "runner", "script"]);
/** Options that take the next word as their value, so that word is a path or a name and not a command word (`npm ci --prefix packages/migrations`). */
const VALUE_OPTIONS = new Set(["--prefix", "--cwd", "-C", "--dir", "--directory", "--workspace", "-w", "--filter", "--project", "-p", "--config", "-c", "--file", "-f", "--schema", "--env-file", "--require", "-r", "--knexfile"]);

/** Whether one word of a command names a seed or a migration: the whole word (or the script's file name) is a verb, with at most the qualifiers above beside it. `seedling` and `reseed` are not. */
function namesSeed(word: string): boolean {
  if (EXTRA_WORDS.has(word)) return true;
  const slash = word.lastIndexOf("/");
  const base = slash < 0 ? word : word.slice(slash + 1);
  if (slash >= 0 && !SCRIPT_EXTENSION.test(base)) return false;
  const parts = base.replace(SCRIPT_EXTENSION, "").toLowerCase().split(/[:_.-]+/u).filter((part) => part !== "");
  if (parts.some((part) => VERBS.has(part)) && parts.every((part) => VERBS.has(part) || QUALIFIERS.has(part))) return true;
  // A script with a generic name inside a migrations or seeds directory: `src/db/migrations/run.js`.
  return slash >= 0 && parts.length > 0 && parts.every((part) => VERBS.has(part) || QUALIFIERS.has(part) || GENERIC_SCRIPT_NAMES.has(part)) && word.slice(0, slash).toLowerCase().split("/").some((directory) => SEED_DIRECTORIES.has(directory));
}

/** A module given to `python -m` (`app.seed`, `app.db.migrate`): a dotted name whose last part names a seed or a migration. */
const seedingModule = (word: string): boolean => !word.includes("/") && word.includes(".") && !SCRIPT_EXTENSION.test(word) && namesSeed(word.slice(word.lastIndexOf(".") + 1));

/** Whether any of the first words (not options, and not an option's value) names a seed or a migration. `extra` also sees the word before it. */
function hasSeedWord(words: readonly string[], extra?: (word: string, previous: string | undefined) => boolean): boolean {
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at]!;
    if (word.startsWith("-")) { if (VALUE_OPTIONS.has(word)) at += 1; continue; }
    if (namesSeed(word) || extra?.(word, words[at - 1]) === true) return true;
  }
  return false;
}

/** Whether a command fills or migrates a database (by the words of its program and arguments), so it must not run in SETUP. */
export function isDatabaseSeedCommand(command: Pick<ProjectCommand, "executable" | "args">): boolean {
  const program = command.executable.split("/").pop() ?? command.executable;
  if (!RUNNERS.has(program)) return false;
  if (program === "psql" || program === "pg_restore") return true;
  const words = command.args.slice(0, 12);
  if (program === "alembic") return words.some((word) => word === "upgrade" || word === "downgrade");
  if (program === "flask" || program === "poetry") return hasSeedWord(words, (word) => word === "upgrade");
  if (program === "python" || program === "python3") return hasSeedWord(words, (word, previous) => previous === "-m" && seedingModule(word));
  return hasSeedWord(words);
}
