// L4-E34 (E3): test rows for the tables a project's migrations and seeds leave EMPTY, in the run's own disposable Postgres. NO AI, NO RANDOMNESS, NO CLOCK: every value is a function of the generator version, the table's name,
// the column's name and type, and the row's number, so the same schema gives byte-identical rows on every run and on both sides of a comparison (an unchanged table has the same rows on the base side and on the change's side).
// Nothing is ever copied from a customer's real database: the only input is the schema of the run's own fresh database (read from its catalog) and a few key values already IN that fresh database (for a foreign key).
//
// Rules, each with a test (tests/unit/worker-service-seed-generate.test.ts):
//   - SCHEMA IN, ROWS OUT. The schema is read from the database's catalog by one fixed statement (`STAND_IN_SCHEMA_STATEMENT`) and checked at runtime (`parseStandInSchema`, bounded). Every identifier that reaches SQL passed
//     `PLAIN_NAME` and is double-quoted; a table or column that does not pass is skipped, in fixed words (`unsafe_name`), never quoted anyway.
//   - ONLY EMPTY TABLES. A table the migrations or the seed files already filled is left as it is. Migration bookkeeping tables are never filled.
//   - KEYS HOLD. Primary and unique key columns take a different value per row; a foreign key takes a key value of a row of the parent (a generated row, or a key already in the database); a required foreign key whose parent
//     has no rows skips the table (`no_parent`), a nullable one is left NULL. A row repeating an earlier row's primary or unique key is dropped. Serial and identity counters are moved past the rows written.
//   - PLAIN SQL ONLY. The statements go through `loadSeedFile` (the no-superuser role, one transaction, no backslash, no PROGRAM): a table whose statement would be refused is skipped (`unsafe_name`), not the whole load. One table
//     failing in the database (a CHECK the generator cannot know) does not stop the others (each table is a `DO` block that catches its own error); a table still empty afterwards is reported `not_filled`.
//   - FIXED WORDS. Reasons are a fixed list; no value, no error text and no statement leaves here.
import { createHash } from "node:crypto";
import { z } from "zod";
import { STAND_IN_ROW_GENERATOR_VERSION } from "@agentx/contracts";
import { seedFileContentProblem } from "./service-seed-file.js";

export { STAND_IN_ROW_GENERATOR_VERSION };

/** Rows made for each empty table. */
export const STAND_IN_ROWS_PER_TABLE = 5;
/** The most tables, columns per table and sampled parent keys one pass reads or writes; more is cut at a stated limit, never silently (`too_many_tables`). */
export const STAND_IN_LIMITS = Object.freeze({ tables: 64, columns: 200, enumValues: 64, parentKeys: STAND_IN_ROWS_PER_TABLE, lookups: 50 });
/** The plain shape of a table or column name that may be quoted into a statement. */
export const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
/** Migration tools' own bookkeeping tables: never filled. */
const BOOKKEEPING = /^(?:_prisma_migrations|schema_migrations|alembic_version|knex_migrations(?:_lock)?|django_migrations|__drizzle_migrations|flyway_schema_history|typeorm_migrations|migrations|sequelizemeta|goose_db_version|schema_version)$/iu;
const BLOCK_TAG = "stand_in";
/** The statement reads at most this many tables beyond the limit, so migration bookkeeping tables do not hide a real one. */
const BOOKKEEPING_ALLOWANCE = 8;
const SCHEMA_READ_LIMIT = 64 + 1 + BOOKKEEPING_ALLOWANCE;

export type StandInSkipReason = "unsafe_name" | "unsupported_type" | "no_parent" | "too_many_tables" | "not_filled" | "has_rows";

// ---- the schema

export interface StandInColumn {
  readonly name: string;
  /** `format_type` of the column, e.g. `integer`, `character varying(30)`, `numeric(10,2)`, `text[]`, or an enum's name. */
  readonly type: string;
  readonly nullable: boolean;
  /** `a` for `GENERATED ALWAYS AS IDENTITY`, `d` for `BY DEFAULT`, `` for none. */
  readonly identity: "" | "a" | "d";
  /** A stored generated column (the database writes it). */
  readonly generated: boolean;
  /** The labels of an enum type (empty for any other type). */
  readonly enumValues: readonly string[];
}
export interface StandInForeignKey { readonly columns: readonly string[]; readonly refTable: string; readonly refColumns: readonly string[] }
export interface StandInTable {
  readonly name: string;
  readonly columns: readonly StandInColumn[];
  readonly primaryKey: readonly string[];
  readonly uniques: ReadonlyArray<readonly string[]>;
  readonly foreignKeys: readonly StandInForeignKey[];
  /** Whether the table already holds a row (a migration or a seed put it there). */
  readonly hasRows: boolean;
}
export interface StandInSchema { readonly tables: readonly StandInTable[]; readonly truncated: boolean; /** Tables left out because they were over a limit or malformed. */ readonly invalid?: number }

const name = z.string().min(1).max(200);
const names = z.array(name).max(32);
// An enum with more labels than the limit keeps the first labels (any label is a valid value); a table over a limit is dropped from the schema (reported), never the whole schema.
const ColumnSchema = z.object({ name, type: z.string().min(1).max(200), nullable: z.boolean(), identity: z.enum(["", "a", "d"]), generated: z.boolean(),
  enumValues: z.array(z.string().max(100)).max(10_000).transform(labels => labels.slice(0, STAND_IN_LIMITS.enumValues)) }).strict();
const TableSchema = z.object({
  name, hasRows: z.boolean(), columns: z.array(ColumnSchema).min(1).max(STAND_IN_LIMITS.columns), primaryKey: names, uniques: z.array(names).max(32),
  foreignKeys: z.array(z.object({ columns: names.min(1), refTable: name, refColumns: names.min(1) }).strict()).max(32),
}).strict();
const SchemaSchema = z.object({ tables: z.array(z.unknown()).max(10_000) }).strict();

/**
 * The schema of the run's database as `STAND_IN_SCHEMA_STATEMENT` printed it, or undefined for a wrong overall shape or a duplicate table. A table that is over a limit (200 columns, 32 keys), has no column, or names a key
 * column it does not have is DROPPED and counted in `invalid` (never the whole schema). Bookkeeping tables are dropped. At most `STAND_IN_LIMITS.tables` tables are kept (in name order); `truncated` says when more existed.
 */
export function parseStandInSchema(raw: unknown): StandInSchema | undefined {
  const parsed = SchemaSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  let invalid = 0;
  const valid: Array<z.infer<typeof TableSchema>> = [];
  for (const item of parsed.data.tables) {
    const table = TableSchema.safeParse(item);
    if (!table.success) { invalid += 1; continue; }
    const columns = new Set(table.data.columns.map(column => column.name));
    const known = (list: readonly string[]): boolean => list.every(column => columns.has(column));
    if (columns.size !== table.data.columns.length || !known(table.data.primaryKey) || !table.data.uniques.every(known) || !table.data.foreignKeys.every(key => known(key.columns) && key.columns.length === key.refColumns.length)) { invalid += 1; continue; }
    valid.push(table.data);
  }
  const all = valid.filter(table => !BOOKKEEPING.test(table.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (new Set(all.map(table => table.name)).size !== all.length) return undefined;
  const kept = all.slice(0, STAND_IN_LIMITS.tables);
  return { tables: kept, truncated: all.length > kept.length || parsed.data.tables.length >= SCHEMA_READ_LIMIT, invalid };
}

/**
 * The one fixed statement that reads the schema of schema `public`: ordinary tables, their columns, keys and whether each holds a row. It prints ONE json line. It names nothing of the project, runs as the database's owner over
 * the helper's local socket, and writes nothing.
 */
export const STAND_IN_SCHEMA_STATEMENT = `SELECT json_build_object('tables', COALESCE(json_agg(t ORDER BY t->>'name'), '[]'::json))::text FROM (
SELECT json_build_object(
 'name', c.relname::text,
 'hasRows', (xpath('/row/c/text()', query_to_xml(format('select (exists(select 1 from %I.%I))::int as c', n.nspname, c.relname), false, true, '')))[1]::text = '1',
 'columns', (SELECT COALESCE(json_agg(json_build_object('name', a.attname::text, 'type', format_type(a.atttypid, a.atttypmod), 'nullable', NOT a.attnotnull, 'identity', a.attidentity::text, 'generated', a.attgenerated::text <> '',
   'enumValues', COALESCE((SELECT json_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = a.atttypid), '[]'::json)) ORDER BY a.attnum), '[]'::json)
   FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
 'primaryKey', COALESCE((SELECT json_agg(a.attname::text ORDER BY k.ord) FROM pg_constraint x CROSS JOIN LATERAL unnest(x.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum WHERE x.conrelid = c.oid AND x.contype = 'p'), '[]'::json),
 'uniques', COALESCE((SELECT json_agg(u.cols) FROM (SELECT (SELECT json_agg(a.attname::text ORDER BY k.ord) FROM unnest(x.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum) AS cols FROM pg_constraint x WHERE x.conrelid = c.oid AND x.contype = 'u') u), '[]'::json),
 'foreignKeys', COALESCE((SELECT json_agg(json_build_object(
   'columns', (SELECT json_agg(a.attname::text ORDER BY k.ord) FROM unnest(x.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum),
   'refTable', rc.relname::text,
   'refColumns', (SELECT json_agg(a.attname::text ORDER BY k.ord) FROM unnest(x.confkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = x.confrelid AND a.attnum = k.attnum)))
   FROM pg_constraint x JOIN pg_class rc ON rc.oid = x.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace WHERE x.conrelid = c.oid AND x.contype = 'f' AND rn.nspname = 'public'), '[]'::json)
) AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname LIMIT ${SCHEMA_READ_LIMIT}) s`;

// ---- values

const digest = (...parts: ReadonlyArray<string | number>): Buffer => createHash("sha256").update([STAND_IN_ROW_GENERATOR_VERSION, ...parts].join("\u0000")).digest();
const intOf = (hash: Buffer): number => hash.readUIntBE(0, 6);
/** Text that is safe to quote into a statement: no backslash, no NUL and no other control character. */
const plainLiteralText = (text: string): boolean => ![...text].some(ch => { const code = ch.charCodeAt(0); return code < 0x20 || code === 0x7f || ch === "\\"; });
const quote = (text: string): string => `'${text.replace(/'/gu, "''")}'`;
const ident = (text: string): string => `"${text}"`;
const EPOCH_MS = Date.UTC(2026, 0, 1);

interface Typed { readonly base: string; readonly length: number | undefined; readonly precision: number | undefined; readonly scale: number | undefined; readonly array: boolean }
function typeOf(type: string): Typed {
  const array = type.endsWith("[]");
  const text = (array ? type.slice(0, -2) : type).toLowerCase();
  const match = /^([a-z][a-z0-9 _.]*?)(?:\((\d{1,4})(?:,\s*(\d{1,4}))?\))?(?: with(?:out)? time zone)?$/u.exec(text);
  const base = (match?.[1] ?? text).trim();
  const withZone = / with time zone$/u.test(text);
  const first = match?.[2] === undefined ? undefined : Number(match[2]);
  const second = match?.[3] === undefined ? undefined : Number(match[3]);
  const numeric = base === "numeric" || base === "decimal";
  return { base: withZone ? `${base} tz` : base, length: numeric ? undefined : first, precision: numeric ? first : undefined, scale: numeric ? second ?? 0 : undefined, array };
}

/** A name-shaped text for a column (email, url, name...), else `<column>_<n>`. */
function textFor(table: string, column: string, row: number, hash: Buffer): string {
  const n = row + 1; const lower = column.toLowerCase();
  if (lower.includes("email")) return `user${n}@example.test`;
  if (lower.includes("url") || lower.includes("uri") || lower.includes("website")) return `https://example.test/${table}/${n}`;
  if (lower.includes("phone")) return `+1555000${String(1000 + n).slice(-4)}`;
  if (lower === "name" || lower.endsWith("_name") || lower === "title" || lower.endsWith("_title")) return `${column.replace(/_/gu, " ")} ${n} ${intOf(hash) % 100}`;
  return `${column}_${n}`;
}

const TEXT_BASES = new Set(["text", "character varying", "varchar", "character", "char", "bpchar", "citext", "name"]);
const INT_BASES = new Set(["integer", "int", "int4", "bigint", "int8", "smallint", "int2"]);
const FLOAT_BASES = new Set(["real", "double precision", "float4", "float8"]);
const INT_MAX: Readonly<Record<string, number>> = { smallint: 32_000, int2: 32_000, integer: 2_000_000_000, int: 2_000_000_000, int4: 2_000_000_000, bigint: 9_000_000_000_000, int8: 9_000_000_000_000 };

/**
 * One column's value for one row as a SQL expression, or undefined when this type is not one the generator can write (a column that needs it then makes the table `unsupported_type`). `key` columns (primary, unique, and
 * referenced by a foreign key) take a value that differs per row; the others take a value fixed by their own name.
 */
export function standInValue(table: string, column: StandInColumn, row: number, key: boolean): string | undefined {
  const typed = typeOf(column.type);
  const hash = digest(table, column.name, column.type, row);
  if (typed.array) return "'{}'";
  if (column.enumValues.length > 0) {
    const label = column.enumValues[(key ? row : intOf(hash)) % column.enumValues.length]!;
    return !plainLiteralText(label) || label.includes("$") ? undefined : quote(label);
  }
  if (INT_BASES.has(typed.base)) {
    const max = INT_MAX[typed.base] ?? 32_000;
    return String(key ? row + 1 : 1 + (intOf(hash) % Math.min(900, max)));
  }
  if (typed.base === "numeric" || typed.base === "decimal") {
    const whole = typed.precision === undefined ? 900 : Math.max(0, typed.precision - (typed.scale ?? 0));
    const limit = whole === 0 ? 1 : Math.min(900, 10 ** whole - 1);
    const integer = whole === 0 ? 0 : key ? 1 + (row % limit) : 1 + (intOf(hash) % limit);
    const scale = typed.scale ?? 2;
    return scale > 0 ? `${integer}.${"5".padEnd(scale, "0").slice(0, scale)}` : String(integer);
  }
  if (FLOAT_BASES.has(typed.base)) return `${key ? row + 1 : 1 + (intOf(hash) % 900)}.5`;
  if (TEXT_BASES.has(typed.base)) {
    const text = textFor(table, column.name, row, hash);
    return quote(typed.length === undefined ? text : text.slice(0, typed.length));
  }
  if (typed.base === "boolean" || typed.base === "bool") return key ? (row % 2 === 0 ? "true" : "false") : (intOf(hash) % 2 === 0 ? "true" : "false");
  const day = new Date(EPOCH_MS + (key ? row : intOf(hash) % 365) * 86_400_000).toISOString();
  if (typed.base === "date") return quote(day.slice(0, 10));
  if (typed.base === "timestamp") return quote(`${day.slice(0, 10)} 00:00:00`);
  if (typed.base === "timestamp tz") return quote(`${day.slice(0, 10)} 00:00:00+00`);
  if (typed.base === "time") return quote("12:00:00");
  if (typed.base === "time tz") return quote("12:00:00+00");
  if (typed.base === "interval") return quote("1 day");
  if (typed.base === "uuid") { const hex = digest(table, column.name, row, "uuid").toString("hex"); return quote(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`); }
  if (typed.base === "json" || typed.base === "jsonb") return quote('{"stand_in":true}');
  if (typed.base === "bytea") return "decode('00ff', 'hex')";
  if (typed.base === "inet") return quote(`10.0.${Math.floor(row / 250) % 250}.${(row % 250) + 1}`);
  if (typed.base === "money") return quote("1.50");
  return undefined;
}

// ---- rows

/** A key value already in the database (a column of a parent row, as a SQL literal). */
export type ParentKey = Readonly<Record<string, string>>;
export interface StandInRows { readonly table: string; readonly columns: readonly string[]; readonly rows: ReadonlyArray<readonly string[]> }
export interface StandInPlan {
  /** The statements to load, or "" when nothing is to be written. */
  readonly sql: string;
  readonly tables: ReadonlyArray<{ readonly table: string; readonly rows: number }>;
  readonly skipped: ReadonlyArray<{ readonly table: string; readonly reason: StandInSkipReason }>;
  /** The rows the statements write, as SQL literals (what a test or a report reads; never sent anywhere). */
  readonly data: readonly StandInRows[];
}

/** The columns that must differ from row to row: primary key, unique keys, and every column a foreign key points at. */
function keyColumnsOf(schema: StandInSchema, table: StandInTable): Set<string> {
  const keys = new Set<string>([...table.primaryKey, ...table.uniques.flat()]);
  for (const other of schema.tables) for (const fk of other.foreignKeys) if (fk.refTable === table.name) for (const column of fk.refColumns) keys.add(column);
  return keys;
}

/** The tables in an order where a parent comes before its children (a parent in a cycle, or a self-reference, is not waited for); ties by name. */
function orderOf(tables: readonly StandInTable[]): StandInTable[] {
  const byName = new Map(tables.map(table => [table.name, table]));
  const ordered: StandInTable[] = []; const state = new Map<string, 1 | 2>();
  const visit = (table: StandInTable): void => {
    if (state.has(table.name)) return;
    state.set(table.name, 1);
    for (const fk of table.foreignKeys) { const parent = byName.get(fk.refTable); if (parent !== undefined && parent !== table) visit(parent); }
    state.set(table.name, 2); ordered.push(table);
  };
  for (const table of tables) visit(table);
  return ordered;
}

interface BuildOptions {
  /** A value to force for one column of one row of one table (a zero-row lookup's key). */
  readonly forced?: ReadonlyMap<string, string> | undefined;
}

/** The value of a self-referencing key column in the first row (a stored generated column, or a type the generator cannot write, gives NULL: the insert then fails in its block, never a throw here). */
function selfKey(table: StandInTable, columnName: string, row: number): string {
  const column = table.columns.find(candidate => candidate.name === columnName);
  return column === undefined || column.generated ? "NULL" : standInValue(table.name, column, row, true) ?? "NULL";
}

/** The rows of one table, or the reason it cannot be written. `parents` holds the rows already known for each table (generated this pass, or sampled keys). */
function rowsOf(schema: StandInSchema, table: StandInTable, parents: ReadonlyMap<string, readonly ParentKey[]>, count: number, rowOffset: number, options: BuildOptions): StandInRows | StandInSkipReason {
  const keys = keyColumnsOf(schema, table);
  const fkColumns = new Map<string, StandInForeignKey>();
  for (const fk of table.foreignKeys) for (const column of fk.columns) fkColumns.set(column, fk);
  const writable = table.columns.filter(column => !column.generated);
  const columns: StandInColumn[] = [];
  for (const column of writable) {
    const fk = fkColumns.get(column.name);
    if (fk !== undefined) {
      const available = fk.refTable === table.name ? count : (parents.get(fk.refTable)?.length ?? 0);
      if (available === 0) { if (column.nullable) continue; return "no_parent"; }
      columns.push(column); continue;
    }
    if (standInValue(table.name, column, 0, keys.has(column.name)) === undefined) { if (column.nullable) continue; return "unsupported_type"; }
    columns.push(column);
  }
  if (columns.length === 0) return "unsupported_type";
  const made: string[][] = [];
  const seen = new Map<string, Set<string>>();
  const uniqueSets: ReadonlyArray<readonly string[]> = [...(table.primaryKey.length > 0 ? [table.primaryKey] : []), ...table.uniques];
  for (let i = 0; i < count; i++) {
    const row = rowOffset + i;
    const values: Record<string, string> = {};
    for (const column of columns) {
      const forced = options.forced?.get(column.name);
      const fk = fkColumns.get(column.name);
      if (forced !== undefined) values[column.name] = forced;
      else if (fk !== undefined) {
        const index = fk.columns.indexOf(column.name);
        const pool = fk.refTable === table.name ? undefined : parents.get(fk.refTable);
        // A self-reference points at the first row of this table (which points at itself).
        values[column.name] = pool === undefined ? selfKey(table, fk.refColumns[index]!, rowOffset) : pool[row % pool.length]![fk.refColumns[index]!] ?? "NULL";
      } else values[column.name] = standInValue(table.name, column, row, keys.has(column.name))!;
    }
    // Drop a row that repeats an earlier row's primary or unique key.
    const duplicate = uniqueSets.some(set => { const tuple = set.map(column => values[column] ?? "NULL").join("\u0000"); const bucket = seen.get(set.join(",")) ?? new Set<string>(); seen.set(set.join(","), bucket); const hit = bucket.has(tuple); bucket.add(tuple); return hit; });
    if (!duplicate) made.push(columns.map(column => values[column.name]!));
  }
  return { table: table.name, columns: columns.map(column => column.name), rows: made };
}

/** The `DO` block that inserts a table's rows, moves the table's counters past them, and catches its own error (one table failing leaves the others). */
function blockOf(table: StandInTable, made: StandInRows): string {
  const target = `${ident("public")}.${ident(table.name)}`;
  const always = table.columns.some(column => column.identity === "a" && made.columns.includes(column.name));
  const insert = `INSERT INTO ${target} (${made.columns.map(ident).join(", ")})${always ? " OVERRIDING SYSTEM VALUE" : ""} VALUES ${made.rows.map(row => `(${row.join(", ")})`).join(", ")};`;
  const counters = table.columns.filter(column => made.columns.includes(column.name) && (column.identity !== "" || /^(?:integer|bigint|smallint)$/u.test(column.type) && table.primaryKey.length === 1 && table.primaryKey[0] === column.name))
    .map(column => `PERFORM setval(pg_get_serial_sequence('${target.replace(/'/gu, "''")}', ${quote(column.name)}), (SELECT COALESCE(MAX(${ident(column.name)}), 1) FROM ${target})) WHERE pg_get_serial_sequence('${target.replace(/'/gu, "''")}', ${quote(column.name)}) IS NOT NULL;`);
  return `DO $${BLOCK_TAG}$ BEGIN ${insert} ${counters.join(" ")} EXCEPTION WHEN OTHERS THEN NULL; END $${BLOCK_TAG}$;`;
}

/** A table's block, or undefined when the load would refuse its text (no backslash, no PROGRAM): that table is skipped, never the whole load. */
function screenedBlock(table: StandInTable, made: StandInRows): string | undefined {
  const block = blockOf(table, made);
  return seedFileContentProblem(Buffer.from(block, "utf8")) === undefined ? block : undefined;
}

function planOf(schema: StandInSchema, accepted: ReadonlyArray<{ table: StandInTable; made: StandInRows; block: string }>, skipped: Array<{ table: string; reason: StandInSkipReason }>): StandInPlan {
  if (schema.truncated) skipped.push({ table: "", reason: "too_many_tables" });
  if ((schema.invalid ?? 0) > 0) skipped.push({ table: "", reason: "unsupported_type" });
  // A name that is not plain is never echoed (it came from a catalog; the report is shown and logged): the entry keeps its reason and an empty name.
  const named = skipped.map(entry => (entry.table === "" || PLAIN_NAME.test(entry.table) ? entry : { table: "", reason: entry.reason }));
  return {
    sql: accepted.length === 0 ? "" : `${accepted.map(entry => entry.block).join("\n")}\n`,
    tables: accepted.map(entry => ({ table: entry.table.name, rows: entry.made.rows.length })), skipped: named, data: accepted.map(entry => entry.made),
  };
}

/**
 * The rows for every EMPTY table of the schema, as statements for `loadSeedFile`, with what was written and what was skipped and why. `existing` holds, for each table that already has rows and is a foreign key's parent, a few of its
 * key values as SQL literals (`sampleKeysStatement` reads them). The same schema, the same `existing` and the same generator version always give the same `sql`.
 */
export function planStandInRows(schema: StandInSchema, existing: ReadonlyMap<string, readonly ParentKey[]> = new Map()): StandInPlan {
  const skipped: Array<{ table: string; reason: StandInSkipReason }> = [];
  const parents = new Map<string, readonly ParentKey[]>(existing);
  const results: Array<{ table: StandInTable; made: StandInRows; block: string }> = [];
  for (const table of orderOf(schema.tables)) {
    if (table.hasRows) { skipped.push({ table: table.name, reason: "has_rows" }); continue; }
    if (!PLAIN_NAME.test(table.name) || table.columns.some(column => !PLAIN_NAME.test(column.name))) { skipped.push({ table: table.name, reason: "unsafe_name" }); continue; }
    const made = rowsOf(schema, table, parents, STAND_IN_ROWS_PER_TABLE, 0, {});
    if (typeof made === "string") { skipped.push({ table: table.name, reason: made }); continue; }
    const block = screenedBlock(table, made);
    // A skipped table is not a parent: its children are skipped (`no_parent`) or leave the column NULL, never point at rows that were not written.
    if (block === undefined) { skipped.push({ table: table.name, reason: "unsafe_name" }); continue; }
    results.push({ table, made, block });
    parents.set(table.name, made.rows.map(row => Object.fromEntries(made.columns.map((column, i) => [column, row[i]!]))));
  }
  return planOf(schema, results, skipped);
}

// ---- parent keys

/** The columns of each non-empty table that a foreign key of an EMPTY table points at (what `sampleKeysStatement` must read). */
export function parentKeyColumns(schema: StandInSchema): Map<string, string[]> {
  const byName = new Map(schema.tables.map(table => [table.name, table]));
  const wanted = new Map<string, Set<string>>();
  for (const child of schema.tables) {
    if (child.hasRows) continue;
    for (const fk of child.foreignKeys) {
      const parent = byName.get(fk.refTable);
      if (parent === undefined || !parent.hasRows || parent === child) continue;
      if (!PLAIN_NAME.test(parent.name) || fk.refColumns.some(column => !PLAIN_NAME.test(column))) continue;
      const set = wanted.get(parent.name) ?? new Set<string>(); fk.refColumns.forEach(column => set.add(column)); wanted.set(parent.name, set);
    }
  }
  return new Map([...wanted].sort(([a], [b]) => (a < b ? -1 : 1)).map(([table, set]) => [table, [...set].sort()]));
}

/**
 * The fixed statement that prints, for each parent table, a few of its existing key values (the first rows by the key columns). Built only from names that passed `PLAIN_NAME` and are in the schema. Undefined when there is no
 * parent to read. These are values of the run's OWN fresh database, read so a foreign key can point at a row that exists.
 */
export function sampleKeysStatement(wanted: ReadonlyMap<string, readonly string[]>): string | undefined {
  if (wanted.size === 0) return undefined;
  // json_build_object takes at most 100 arguments (two per table): at most 50 parents are read, the rest read as having no rows to point at.
  const parts = [...wanted].slice(0, 50).map(([table, columns]) => `${quote(table)}, (SELECT COALESCE(json_agg(x), '[]'::json) FROM (SELECT ${columns.map(ident).join(", ")} FROM ${ident("public")}.${ident(table)} ORDER BY ${columns.map(ident).join(", ")} LIMIT ${STAND_IN_LIMITS.parentKeys}) x)`);
  return `SELECT json_build_object(${parts.join(", ")})::text`;
}

const SqlScalar = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]);
/** The sampled keys as `sampleKeysStatement` printed them, as SQL literals; anything else (or a value with a backslash, a NUL or a control character) is no sample. */
export function parseSampledKeys(raw: unknown, wanted: ReadonlyMap<string, readonly string[]>): Map<string, ParentKey[]> {
  const out = new Map<string, ParentKey[]>();
  const parsed = z.record(z.string(), z.array(z.record(z.string(), SqlScalar)).max(STAND_IN_LIMITS.parentKeys)).safeParse(raw);
  if (!parsed.success) return out;
  for (const [table, rows] of Object.entries(parsed.data)) {
    const columns = wanted.get(table); if (columns === undefined) continue;
    const keys: ParentKey[] = [];
    for (const row of rows) {
      const literals: Record<string, string> = {}; let ok = true;
      for (const column of columns) {
        const value = row[column];
        if (typeof value === "number") literals[column] = String(value);
        else if (typeof value === "boolean") literals[column] = value ? "true" : "false";
        else if (typeof value === "string" && plainLiteralText(value) && !value.includes(`$${BLOCK_TAG}$`)) literals[column] = quote(value);
        else ok = false;
      }
      if (ok) keys.push(literals);
    }
    if (keys.length > 0) out.set(table, keys);
  }
  return out;
}

// ---- zero-row lookups (the fill pass)

/** A lookup the stand-in database answered with no row: the table and column asked and the key value. Who watches the database for them is the caller's (the test-service wiring); the generator only answers them. */
export interface ZeroRowLookup { readonly table: string; readonly column: string; readonly value: string | number }

/**
 * Rows for the keys that lookups asked for and found nothing: one row per distinct lookup, with the asked key value in its column, every other column the generator's value, and each foreign key pointing at a parent that
 * exists. A lookup naming a table or column that is not in the schema, a value that is not plain, or a table that cannot be written is skipped, in fixed words. At most `STAND_IN_LIMITS.lookups` lookups. Deterministic: the same
 * lookups on the same schema give the same statements, so both sides of a comparison get identical rows.
 */
export function planFillForLookups(schema: StandInSchema, lookups: readonly ZeroRowLookup[], existing: ReadonlyMap<string, readonly ParentKey[]> = new Map()): StandInPlan {
  const skipped: Array<{ table: string; reason: StandInSkipReason }> = [];
  const byName = new Map(schema.tables.map(table => [table.name, table]));
  const results: Array<{ table: StandInTable; made: StandInRows; block: string }> = [];
  const distinct = new Map<string, ZeroRowLookup>();
  for (const lookup of lookups.slice(0, STAND_IN_LIMITS.lookups)) distinct.set(`${lookup.table}\u0000${lookup.column}\u0000${String(lookup.value)}`, lookup);
  for (const lookup of [...distinct.values()].sort((a, b) => (`${a.table}.${a.column}.${String(a.value)}` < `${b.table}.${b.column}.${String(b.value)}` ? -1 : 1))) {
    const table = byName.get(lookup.table);
    const column = table?.columns.find(candidate => candidate.name === lookup.column);
    if (table === undefined || column === undefined) { skipped.push({ table: "", reason: "unsafe_name" }); continue; }
    if (!PLAIN_NAME.test(table.name) || table.columns.some(candidate => !PLAIN_NAME.test(candidate.name))) { skipped.push({ table: table.name, reason: "unsafe_name" }); continue; }
    const literal = typeof lookup.value === "number" ? (Number.isFinite(lookup.value) ? String(lookup.value) : undefined)
      : typeof lookup.value === "string" && lookup.value.length <= 200 && plainLiteralText(lookup.value) && !lookup.value.includes(`$${BLOCK_TAG}$`) ? quote(lookup.value) : undefined;
    if (literal === undefined || column.generated) { skipped.push({ table: table.name, reason: "unsafe_name" }); continue; }
    // The row number comes from the lookup itself, so it does not depend on which other lookups there were.
    const rowNumber = intOf(digest("fill", table.name, lookup.column, String(lookup.value))) % 100_000 + STAND_IN_ROWS_PER_TABLE;
    const made = rowsOf(schema, table, existing, 1, rowNumber, { forced: new Map([[lookup.column, literal]]) });
    if (typeof made === "string") { skipped.push({ table: table.name, reason: made }); continue; }
    const block = screenedBlock(table, made);
    if (block === undefined) { skipped.push({ table: table.name, reason: "unsafe_name" }); continue; }
    results.push({ table, made, block });
  }
  return planOf(schema, results, skipped);
}

/** Every table still empty after a pass, among those the plan meant to write: reported `not_filled`. */
export function notFilled(plan: StandInPlan, after: StandInSchema): Array<{ table: string; reason: "not_filled" }> {
  const hasRows = new Map(after.tables.map(table => [table.name, table.hasRows]));
  return plan.tables.filter(entry => hasRows.get(entry.table) !== true).map(entry => ({ table: entry.table, reason: "not_filled" as const }));
}
