import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export type HostDatabase = DatabaseSync;

// `schema.sql` is the one authoritative definition and `tsc` does not copy it into
// `dist`, so look beside the module first and fall back to the source tree. Keeping the
// SQL in a file rather than a template literal means the schema stays reviewable as SQL.
const SCHEMA_CANDIDATES = [
  resolve(dirname(fileURLToPath(import.meta.url)), "schema.sql"),
  resolve(dirname(fileURLToPath(import.meta.url)), "../../src/store/schema.sql"),
];

function readSchema(): string {
  for (const candidate of SCHEMA_CANDIDATES) {
    try {
      return readFileSync(candidate, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`host schema.sql not found in ${SCHEMA_CANDIDATES.join(", ")}`);
}

/**
 * Open the canonical host database.
 *
 * WAL plus `synchronous = FULL` because this file is the restart boundary: an
 * operation the caller was told about must still be there after a power loss, not
 * merely after a clean exit. Foreign keys are on so a dangling reference is a write
 * error at the moment it is made rather than a mystery on some later read.
 */
export function openHostDatabase(file: string): HostDatabase {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  const database = new DatabaseSync(resolve(file));
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(readSchema());
  return database;
}

/**
 * Run `work` in one immediate transaction.
 *
 * `BEGIN IMMEDIATE` takes the write lock up front, so two concurrent accepts contend
 * here instead of discovering the conflict halfway through. Any throw rolls the whole
 * thing back, which is what makes "accept the operation, index the request and queue
 * the invocation" a single fact rather than three hopeful ones.
 */
export function inTransaction<T>(database: HostDatabase, work: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The transaction was already resolved; report the original failure instead.
    }
    throw error;
  }
}
