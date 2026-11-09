// Proof and evidence P4: migration evidence. When a project has database migrations, its own checks already say whether they apply (a command such as `alembic upgrade head`, `manage.py migrate`, `flyway
// migrate`) and, where the project has one, whether they roll back (`alembic downgrade`, `db:rollback`). AgentX never changes or adds a command: it recognises those commands from their own command lines,
// takes their outcomes from the check round, and says WHICH migrations the change adds or edits (the files, from the diff) and which tables and columns they touch (names only, from the files in the
// checked tree). It claims nothing about a database it did not see:
//   - the "apply" command must have passed in this round for the migrations to be listed as applied;
//   - "rolled back" is true only when a rollback command passed, false when one failed, and unknown (null) when the project has none or it did not finish.
// A migration file's text is data: only identifiers (letters, digits, `_` and `.`) are copied out of it, never a statement, a value or a comment.
import type { CheckEntry, ProjectCommand } from "@agentx/contracts";
import { plainPath } from "./cobertura-lcov-coverage.js";
import type { CandidateChange } from "./diff.js";

export type MigrationDirection = "up" | "down";

// A rollback is tested first: `migrate ... zero`, `db:rollback` and `migrate:down` also contain words an apply command has.
const DOWN: readonly RegExp[] = [
  /\balembic\b[^\n]*\bdowngrade\b/iu, /\bdb\s+downgrade\b/iu, /\bmigrate\b[^\n]*\bzero\b/iu, /\bflyway\b[^\n]*\bundo\b/iu,
  /\bdb:(?:rollback|migrate:(?:down|undo(?::all)?|redo))\b/iu, /\bmigrate:(?:rollback|down|undo)\b/iu, /\bmigration:(?:revert|down)\b/iu,
  /\bgoose\b[^\n]*\bdown(?:-to)?\b/iu, /\bmigrate\b[^\n]*\bdown\b/iu, /\bsqitch\s+revert\b/iu, /\bliquibase\b[^\n]*\brollback/iu,
  /\bdbmate\b[^\n]*\b(?:down|rollback)\b/iu, /\batlas\s+migrate\s+down\b/iu, /\bdiesel\s+migration\s+revert\b/iu, /\bsqlx\s+migrate\s+revert\b/iu,
  /\bdatabase\s+update\s+0\b/iu, /\bnpm\s+run\s+(?:db:)?(?:rollback|migrate:down)\b/iu,
];
const UP: readonly RegExp[] = [
  /\balembic\b[^\n]*\bupgrade\b/iu, /\bdb\s+upgrade\b/iu, /\b(?:manage\.py|django-admin)\s+migrate\b/iu, /\bflyway\b[^\n]*\bmigrate\b/iu,
  /\bprisma\s+migrate\s+(?:deploy|dev|reset)\b/iu, /\bdb:migrate\b/iu, /\bmigrate:(?:latest|up)\b/iu, /\bmigration:(?:run|up)\b/iu,
  /\bgoose\b[^\n]*\bup(?:-to|-by-one)?\b/iu, /\bmigrate\b[^\n]*\bup\b/iu, /\bsqitch\s+deploy\b/iu, /\bliquibase\b[^\n]*\bupdate\b/iu,
  /\bdbmate\b[^\n]*\bup\b/iu, /\batlas\s+migrate\s+apply\b/iu, /\bdiesel\s+migration\s+run\b/iu, /\bsqlx\s+migrate\s+run\b/iu, /\bdatabase\s+update\b/iu,
];

/** Whether a command's own line applies migrations ("up") or rolls them back ("down"). Undefined for any other command. */
export function migrationDirectionOf(command: ProjectCommand): MigrationDirection | undefined {
  const line = [command.executable.split("/").at(-1) ?? command.executable, ...command.args].join(" ").slice(0, 2_000);
  if (DOWN.some((pattern) => pattern.test(line))) return "down";
  if (UP.some((pattern) => pattern.test(line))) return "up";
  return undefined;
}

const MIGRATION_EXTENSION = /\.(?:sql|py|js|ts|rb|go|cs|xml|ya?ml|json|kt|java)$/iu;
/** A path a migration tool keeps migrations at: a `migrations` or `migrate` folder, alembic's `versions`, or a Flyway file name. */
export function isMigrationPath(path: string): boolean {
  const lower = path.toLowerCase().replaceAll("\\", "/");
  const name = lower.split("/").at(-1) ?? "";
  if (!MIGRATION_EXTENSION.test(name) || name.startsWith("__init__") || name === "readme.md") return false;
  return /(^|\/)(?:migrations?|migrate)\//u.test(lower) || /(^|\/)alembic\/versions\//u.test(lower) || /(^|\/)v\d[\w.]*__[^/]+\.sql$/u.test(lower);
}

/** The added or edited migration files of a change (a deleted one is not applied by anything). */
export function changedMigrationFiles(changes: readonly CandidateChange[]): string[] {
  return changes.filter((change) => (change.status === "ADDED" || change.status === "MODIFIED") && isMigrationPath(change.path)).map((change) => change.path);
}

/** A migration's id: its file name without the extension. */
export function migrationIdOf(path: string): string {
  return plainPath((path.split("/").at(-1) ?? path).replace(/\.[^.]+$/u, ""), 100);
}

// ---- the tables and columns a migration touches (identifiers only)

const IDENTIFIER = String.raw`[\x60"\[]?([A-Za-z_][\w.]{0,80})[\x60"\]]?`;
const RULES: ReadonlyArray<{ pattern: RegExp; line: (match: RegExpExecArray) => string }> = [
  { pattern: new RegExp(String.raw`\bcreate\s+(?:temporary\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${IDENTIFIER}`, "giu"), line: (m) => `create table ${m[1]!}` },
  { pattern: new RegExp(String.raw`\bdrop\s+table\s+(?:if\s+exists\s+)?${IDENTIFIER}`, "giu"), line: (m) => `drop table ${m[1]!}` },
  { pattern: new RegExp(String.raw`\balter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?${IDENTIFIER}\s+(add|drop|alter|rename)\s+(?:column\s+|constraint\s+)?(?:if\s+(?:not\s+)?exists\s+)?${IDENTIFIER}`, "giu"), line: (m) => `alter table ${m[1]!}: ${m[2]!.toLowerCase()} ${m[3]!}` },
  { pattern: /\bop\.create_table\(\s*['"](\w+)/gu, line: (m) => `create table ${m[1]!}` },
  { pattern: /\bop\.drop_table\(\s*['"](\w+)/gu, line: (m) => `drop table ${m[1]!}` },
  { pattern: /\bop\.add_column\(\s*['"](\w+)['"]\s*,\s*(?:\w+\.)?Column\(\s*['"](\w+)/gu, line: (m) => `alter table ${m[1]!}: add ${m[2]!}` },
  { pattern: /\bop\.drop_column\(\s*['"](\w+)['"]\s*,\s*['"](\w+)/gu, line: (m) => `alter table ${m[1]!}: drop ${m[2]!}` },
  { pattern: /\bmigrations\.CreateModel\(\s*name=['"](\w+)/gu, line: (m) => `create table ${m[1]!}` },
  { pattern: /\bmigrations\.DeleteModel\(\s*name=['"](\w+)/gu, line: (m) => `drop table ${m[1]!}` },
  { pattern: /\bmigrations\.AddField\(\s*model_name=['"](\w+)['"]\s*,\s*name=['"](\w+)/gu, line: (m) => `alter table ${m[1]!}: add ${m[2]!}` },
  { pattern: /\bmigrations\.RemoveField\(\s*model_name=['"](\w+)['"]\s*,\s*name=['"](\w+)/gu, line: (m) => `alter table ${m[1]!}: drop ${m[2]!}` },
  { pattern: /\bcreate_table\s+[:'"](\w+)/gu, line: (m) => `create table ${m[1]!}` },
  { pattern: /\bdrop_table\s+[:'"](\w+)/gu, line: (m) => `drop table ${m[1]!}` },
  { pattern: /\badd_column\s+[:'"](\w+)['"]?\s*,\s*[:'"](\w+)/gu, line: (m) => `alter table ${m[1]!}: add ${m[2]!}` },
  { pattern: /\bremove_column\s+[:'"](\w+)['"]?\s*,\s*[:'"](\w+)/gu, line: (m) => `alter table ${m[1]!}: drop ${m[2]!}` },
];
export const SCHEMA_CHANGES_MAX = 100;
const SCHEMA_TEXT_MAX = 256 * 1024;

/** Table and column names a migration file creates, alters or drops (SQL, Alembic, Django and Rails forms), as short fixed-shape lines. Bounded; a file past 256 KiB is not read. */
export function schemaChangesOf(source: string): string[] {
  if (source.length > SCHEMA_TEXT_MAX) return [];
  const found: string[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (let match = rule.pattern.exec(source); match !== null && found.length < SCHEMA_CHANGES_MAX * 4; match = rule.pattern.exec(source)) {
      found.push(plainPath(rule.line(match), 200));
      if (match[0] === "") rule.pattern.lastIndex += 1;
    }
  }
  return [...new Set(found)].slice(0, SCHEMA_CHANGES_MAX);
}

// ---- the evidence

export interface MigrationEvidence { applied: string[]; rolledBack: boolean | null; schemaChanges: string[] }

/**
 * The migration part for the check at `upIndex`, from the round's own outcomes: the migrations the change adds or edits (ids) when the apply command passed; whether the rollback command(s) passed. Undefined when
 * the apply command did not pass or the change touches no migration. `readFile` returns a changed migration's text from the checked tree (or undefined).
 */
export async function migrationEvidence(input: {
  upEntry: CheckEntry | undefined;
  downEntries: readonly (CheckEntry | undefined)[];
  changedFiles: readonly string[];
  readFile: (path: string) => Promise<string | undefined>;
}): Promise<MigrationEvidence | undefined> {
  if (input.upEntry?.after !== "passed" || input.changedFiles.length === 0) return undefined;
  const applied = [...new Set(input.changedFiles.map(migrationIdOf))].slice(0, 50);
  const outcomes = input.downEntries.map((entry) => entry?.after);
  // Every rollback command must have passed for "rolled back"; a failed one says it did not; anything else (no such command, not finished) is unknown.
  const rolledBack = outcomes.length === 0 ? null : outcomes.some((outcome) => outcome === "failed") ? false : outcomes.every((outcome) => outcome === "passed") ? true : null;
  const schemaChanges: string[] = [];
  for (const path of input.changedFiles.slice(0, 20)) {
    const text = await input.readFile(path).catch(() => undefined);
    if (text !== undefined) schemaChanges.push(...schemaChangesOf(text));
  }
  return { applied, rolledBack, schemaChanges: [...new Set(schemaChanges)].slice(0, SCHEMA_CHANGES_MAX) };
}
