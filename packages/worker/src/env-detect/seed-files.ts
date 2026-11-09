// Seed files (TS-UX-1 item 8): SQL files in a repository that hold test data for its database: a `.sql` file in a `seeds/`, `seed/`, `seeders/` or `db/seeds/` folder, or one named for a seed (`seed.sql`,
// `test-seed.sql`, `users.seed.sql`). A file with a pg_dump-style `COPY ... FROM stdin` block or a backslash is not offered (a note says why). Offered as the database dependency's FILE seed (SQL the database's own client runs as a role with no superuser rights, in the sealed test database), preferred over a command that fills the database. Each candidate is read through the bounded reader, for that check only.
import { DEPENDENCY_SKIP_DIRS } from "./dependency-candidates.js";
import type { Detector, Located } from "./types.js";

/** The most seed files one repository offers (the contract's seeds-per-dependency limit is 8, and a command may still sit beside them). */
export const SEED_FILES_MAX = 4;
const SEED_FOLDER = /(?:^|\/)(?:seeds?|seeders|seed-data|seed_data)\/(?:[^/]+\/)?[^/]+\.sql$/u;
const SEED_NAME = /(?:^|\/)(?:[a-z0-9_-]{0,40}[._-])?seeds?(?:[._-][a-z0-9_-]{0,40})?\.sql$/iu;
/** Tests' own fixtures and migrations are not seeds: a migration builds the schema (the project's commands do that), and a test fixture belongs to its test. */
const NOT_SEED = /(?:^|\/)(?:migrations?|tests?|__tests__|spec)\//u;

/** The repository's seed files, in path order, at most `SEED_FILES_MAX`. */
export function seedFilesOf(paths: readonly string[]): Array<Located<string>> {
  return paths.filter((path) => !DEPENDENCY_SKIP_DIRS.test(path) && !NOT_SEED.test(path) && (SEED_FOLDER.test(path) || SEED_NAME.test(path)))
    .sort().slice(0, SEED_FILES_MAX).map((path) => ({ value: path, source: { path, line: 1 } }));
}

/** Why a found SQL file is not offered: a pg_dump-style `COPY ... FROM stdin` block (and any backslash, which psql reads as a command) is not loaded by a file seed. */
export const SEED_FILE_DUMP_NOTE = "A SQL seed file was found but not offered: it holds a pg_dump-style COPY ... FROM stdin block or a psql command (a backslash), which a seed file does not run. Write it as INSERT statements (pg_dump --inserts) to use it as the test database's seed.";

export const detectSeedFiles: Detector = async ({ repo }) => {
  const offered: Array<Located<string>> = [];
  let dump = false;
  for (const file of seedFilesOf(repo.paths)) {
    const text = await repo.read(file.value);
    // A file the reader cannot read (too large, the budget gone) is still offered: the worker checks it again when it loads it.
    if (text !== undefined && (text.includes("\\") || /\bfrom\s+stdin\b/iu.test(text))) { dump = true; continue; }
    offered.push(file);
  }
  return { ...(offered.length === 0 ? {} : { seedFiles: offered }), ...(dump ? { notes: [SEED_FILE_DUMP_NOTE] } : {}) };
};
