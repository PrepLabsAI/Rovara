// L4-E34 (E3): each side of an eval comparison gets its OWN fresh database: the project's migrations first, then its seeds, then generated rows for the tables still empty. The same schema and seeds give identical rows on both
// sides; a failing migration or seed ends the side with a fixed reason; the fill pass writes the same missing keys to both sides, once. The database here is a small simulation (a real Postgres is not available to unit tests).
import { describe, expect, it } from "vitest";
import { formatCommandLine, type ProjectCommand } from "@agentx/contracts";
import { SeedFileError } from "../../packages/worker/src/service-seed-file.js";
import { STAND_IN_SCHEMA_STATEMENT, type StandInColumn } from "../../packages/worker/src/service-seed-generate.js";
import { STAND_IN_STEPS_MAX, StandInPrepareError, createFillPass, prepareStandInDatabase, sharedStandInVersion, type StandInDatabasePort, type StandInStep } from "../../packages/worker/src/verification/eval-database-prep.js";

const command = (executable: string, ...args: string[]): ProjectCommand => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const MIGRATE = command("alembic", "upgrade", "head");
const col = (name: string, type: string, extra: Partial<StandInColumn> = {}): StandInColumn => ({ name, type, nullable: false, identity: "", generated: false, enumValues: [], ...extra });
const USERS = { name: "users", primaryKey: ["id"], uniques: [["email"]], foreignKeys: [], columns: [col("id", "integer"), col("email", "text")] };
const ORGS = { name: "orgs", primaryKey: ["id"], uniques: [], foreignKeys: [], columns: [col("id", "uuid"), col("name", "text")] };
const POSTS = { name: "posts", primaryKey: ["id"], uniques: [], columns: [col("id", "integer"), col("author_id", "integer"), col("title", "text")], foreignKeys: [{ columns: ["author_id"], refTable: "users", refColumns: ["id"] }] };
const LATER = { name: "audit", primaryKey: ["id"], uniques: [], foreignKeys: [], columns: [col("id", "integer"), col("note", "text")] };

/** A simulated database: a migration command creates its tables, a seed file marked `-- seed:<table>` puts a row in that table, an INSERT block puts the rows it names; the two reads answer from the state. */
function simulated(options: { migrations?: Record<string, unknown[]>; failCommand?: string; timeoutCommand?: string; failSql?: (sql: string) => boolean; sqlError?: SeedFileError; garbageSchema?: boolean; garbageAfterGenerated?: boolean } = {}) {
  const tables = new Map<string, { def: Record<string, unknown>; rows: number }>();
  const log: string[] = []; const sql: string[] = []; const reads: string[] = []; let generated = false;
  const port: StandInDatabasePort = {
    async runCommand(cmd) {
      const line = formatCommandLine(cmd); log.push(`cmd ${line}`);
      if (line === options.timeoutCommand) return { exitCode: null, timedOut: true };
      if (line === options.failCommand) return { exitCode: 1, timedOut: false };
      for (const def of options.migrations?.[line] ?? []) tables.set((def as { name: string }).name, { def: def as Record<string, unknown>, rows: 0 });
      return { exitCode: 0, timedOut: false };
    },
    async loadSql(bytes) {
      const text = bytes.toString("utf8"); if (text.startsWith("DO $stand_in$")) generated = true; log.push(`sql ${text.slice(0, 20).replace(/\n/gu, " ")}`); sql.push(text);
      if (options.sqlError !== undefined) throw options.sqlError;
      if (options.failSql?.(text) === true) throw new SeedFileError("load_failed");
      for (const m of text.matchAll(/-- seed:(\w+)/gu)) { const t = tables.get(m[1]!); if (t) t.rows += 1; }
      for (const m of text.matchAll(/INSERT INTO "public"\."(\w+)"/gu)) { const t = tables.get(m[1]!); if (t) t.rows += 5; }
    },
    async readText(statement) {
      reads.push(statement.slice(0, 40));
      if (options.garbageSchema === true || (options.garbageAfterGenerated === true && generated && statement === STAND_IN_SCHEMA_STATEMENT)) return "not json";
      if (statement === STAND_IN_SCHEMA_STATEMENT) return JSON.stringify({ tables: [...tables.values()].map(({ def, rows }) => ({ ...def, hasRows: rows > 0 })) });
      const named = [...statement.matchAll(/'(\w+)', \(SELECT COALESCE/gu)].map(m => m[1]!);
      return JSON.stringify(Object.fromEntries(named.map(name => [name, [{ id: 1 }, { id: 2 }]])));
    },
  };
  return { port, tables, log, sql };
}
const seedFile = (table: string, extra = "") => ({ kind: "file" as const, bytes: Buffer.from(`-- seed:${table}\ninsert into ${table} values (1);${extra}\n`) });
const signal = () => new AbortController().signal;
const reasonOf = async (promise: Promise<unknown>): Promise<string> => { try { await promise; return "ok"; } catch (error) { return error instanceof StandInPrepareError ? error.reason : `other: ${String(error)}`; } };
const MIGRATIONS = { "alembic upgrade head": [USERS, ORGS, POSTS] };

describe("one side's fresh database", () => {
  it("ends the side with a fixed reason, and runs nothing after it, for a failed or timed-out migration or seed, a rollback command, too many steps and a stop", async () => {
    const down = command("alembic", "downgrade", "base"); const seedCommand = command("npm", "run", "seed");
    const failing = simulated({ migrations: MIGRATIONS, failCommand: "alembic upgrade head" });
    expect(await reasonOf(prepareStandInDatabase({ side: "new", database: failing.port, steps: [{ kind: "command", command: MIGRATE }, seedFile("users")], signal: signal() }))).toBe("migration_failed");
    expect(failing.log).toEqual(["cmd alembic upgrade head"]);
    expect(await reasonOf(prepareStandInDatabase({ side: "new", database: simulated({ timeoutCommand: "alembic upgrade head" }).port, steps: [{ kind: "command", command: MIGRATE }], signal: signal() }))).toBe("migration_timeout");
    expect(await reasonOf(prepareStandInDatabase({ side: "new", database: simulated({ failCommand: "npm run seed" }).port, steps: [{ kind: "command", command: seedCommand }], signal: signal() }))).toBe("seed_failed");
    expect(await reasonOf(prepareStandInDatabase({ side: "new", database: simulated({ timeoutCommand: "npm run seed" }).port, steps: [{ kind: "command", command: seedCommand }], signal: signal() }))).toBe("seed_timeout");
    expect(await reasonOf(prepareStandInDatabase({ side: "new", database: simulated({ migrations: MIGRATIONS, failSql: t => t.includes("seed:users") }).port, steps: [{ kind: "command", command: MIGRATE }, seedFile("users")], signal: signal() }))).toBe("seed_failed");
    expect(await reasonOf(prepareStandInDatabase({ side: "new", database: simulated({ migrations: MIGRATIONS, sqlError: new SeedFileError("timeout") }).port, steps: [{ kind: "command", command: MIGRATE }, seedFile("users")], signal: signal() }))).toBe("seed_timeout");
    const rollback = simulated({ migrations: MIGRATIONS });
    expect(await reasonOf(prepareStandInDatabase({ side: "new", database: rollback.port, steps: [{ kind: "command", command: MIGRATE }, { kind: "command", command: down }], signal: signal() }))).toBe("migration_rollback");
    expect(rollback.log).toEqual([]);
    const many = simulated();
    expect(await reasonOf(prepareStandInDatabase({ side: "new", database: many.port, steps: Array.from({ length: STAND_IN_STEPS_MAX + 1 }, () => seedFile("users")), signal: signal() }))).toBe("too_many_steps"); expect(many.log).toEqual([]);
    const stop = new AbortController(); stop.abort(); const stopped = simulated({ migrations: MIGRATIONS });
    expect(await reasonOf(prepareStandInDatabase({ side: "new", database: stopped.port, steps: [{ kind: "command", command: MIGRATE }], signal: stop.signal }))).toBe("stopped"); expect(stopped.log).toEqual([]);
  });
  it("a schema that cannot be read is not a failure: the migrations and seeds stand, nothing is generated, and the report says so in fixed words", async () => {
    const db = simulated({ migrations: MIGRATIONS, garbageSchema: true });
    const { report, filler } = await prepareStandInDatabase({ side: "new", database: db.port, steps: [{ kind: "command", command: MIGRATE }, seedFile("users")], signal: signal() });
    expect(report.filled).toEqual([]); expect(report.skipped).toEqual([{ table: "", reason: "not_filled" }]); expect(report.seedDigests).toHaveLength(1);
    expect(db.sql.every(text => !text.includes("$stand_in$"))).toBe(true);
    expect(await filler.fill([{ table: "users", column: "email", value: "a@example.test" }], signal())).toEqual({ filled: [], skipped: [{ table: "", reason: "not_filled" }] });
  });
  it("a schema that cannot be read AFTER the generated rows loaded is not a failure either: nothing is counted as filled, the seeds stand, the filler still comes back", async () => {
    const db = simulated({ migrations: MIGRATIONS, garbageAfterGenerated: true });
    const { report, filler } = await prepareStandInDatabase({ side: "new", database: db.port, steps: [{ kind: "command", command: MIGRATE }, seedFile("users")], signal: signal() });
    expect(report.filled).toEqual([]); expect(report.skipped).toEqual([{ table: "orgs", reason: "not_filled" }, { table: "posts", reason: "not_filled" }]); expect(report.seedDigests).toHaveLength(1);
    expect(typeof filler.fill).toBe("function");
  });
});

describe("the stand-in set version of a comparison", () => {
  const prepare = async (seeds: StandInStep[], migrations = MIGRATIONS) => (await prepareStandInDatabase({ side: "new", database: simulated({ migrations }).port, steps: [{ kind: "command", command: MIGRATE }, ...seeds], signal: signal() })).report;
  const images = ["registry.example/postgres@sha256:" + "1".repeat(64)];
  it("is the same for the same seeds on both sides and for an unchanged set on the next run", async () => {
    const a = sharedStandInVersion([await prepare([seedFile("users")]), await prepare([seedFile("users")], { "alembic upgrade head": [USERS, ORGS, POSTS, LATER] })], { images });
    const b = sharedStandInVersion([await prepare([seedFile("users")])], { images });
    expect(a.status).toBe("same"); expect(b.status).toBe("same");
    expect(a).toEqual(b);
  });
  it("is `differs` when the two sides were loaded from different seeds (never a version that hides unequal data), and `none` with no side", async () => {
    expect(sharedStandInVersion([await prepare([seedFile("users")]), await prepare([seedFile("users", " ")])], { images })).toEqual({ status: "differs" });
    expect(sharedStandInVersion([], { images })).toEqual({ status: "none" });
  });
});

describe("the fill and re-ask pass", () => {
  const prepared = async (side: "old" | "new", options: Parameters<typeof simulated>[0] = { migrations: MIGRATIONS }) => {
    const db = simulated(options); const { filler } = await prepareStandInDatabase({ side, database: db.port, steps: [{ kind: "command", command: MIGRATE }, seedFile("users")], signal: signal() });
    return { db, filler };
  };
  it("returns nothing, and never throws, when the observer fails, nothing was seen, a name is not plain, the sides' writes differ, the load fails or the run is stopped", async () => {
    const old = await prepared("old"); const changed = await prepared("new");
    const ask = (over: Partial<Parameters<typeof createFillPass>[0]>) => createFillPass({ fillers: [old.filler, changed.filler], signal: signal(), observed: async () => [], ...over })({ ids: ["q1"] });
    expect(await ask({ observed: async () => { throw new Error("private-observer-failure"); } })).toEqual([]);
    expect(await ask({})).toEqual([]);
    expect(await ask({ observed: async () => [{ questionId: "q1", lookup: { table: 'users"; drop', column: "email", value: 1 }, side: "old" as const }] })).toEqual([]);
    expect(await ask({ observed: async () => [{ questionId: "q1", lookup: { table: "ghosts", column: "id", value: 1 }, side: "old" as const }] })).toEqual([]);
    const refused = await prepared("new", { migrations: MIGRATIONS, failSql: t => t.includes("who@example.test") });
    expect(await createFillPass({ fillers: [old.filler, refused.filler], signal: signal(), observed: async () => [{ questionId: "q1", lookup: { table: "users", column: "email", value: "who@example.test" }, side: "old" as const }] })({ ids: ["q1"] })).toEqual([]);
    const stop = new AbortController(); stop.abort();
    expect(await ask({ signal: stop.signal, observed: async () => [{ questionId: "q1", lookup: { table: "users", column: "email", value: "z@example.test" }, side: "old" as const }] })).toEqual([]);
  });
  it("a logging failure changes nothing", async () => {
    const old = await prepared("old");
    const pass = createFillPass({ fillers: [old.filler], signal: signal(), log: () => { throw new Error("log down"); }, observed: async () => [{ questionId: "q1", lookup: { table: "users", column: "email", value: "a@example.test" }, side: "old" as const }] });
    expect(await pass({ ids: ["q1"] })).toEqual(["q1"]);
  });
});

