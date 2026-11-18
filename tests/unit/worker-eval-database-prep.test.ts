// L4-E34 (E3): each side of an eval comparison gets its OWN fresh database: the project's migrations first, then its seeds, then generated rows for the tables still empty. The same schema and seeds give identical rows on both
// sides; a failing migration or seed ends the side with a fixed reason; the fill pass writes the same missing keys to both sides, once. The database here is a small simulation (a real Postgres is not available to unit tests).
import { describe, expect, it, vi } from "vitest";
import { formatCommandLine, type ProjectCommand } from "@agentx/contracts";
import { SeedFileError, seedFileDigest } from "../../packages/worker/src/service-seed-file.js";
import { STAND_IN_ROW_GENERATOR_VERSION, STAND_IN_SCHEMA_STATEMENT, type StandInColumn } from "../../packages/worker/src/service-seed-generate.js";
import {
  STAND_IN_STEPS_MAX, StandInPrepareError, createFillPass, postgresStandInDatabase, prepareStandInDatabase, seedCommandDigest, sharedStandInVersion, type StandInDatabasePort, type StandInStep,
} from "../../packages/worker/src/verification/eval-database-prep.js";

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
  it("runs the migrations first (whatever order the plan listed them), then the seeds in their order, then generated rows", async () => {
    const db = simulated({ migrations: MIGRATIONS });
    const seedCommand = command("npm", "run", "seed");
    const { report } = await prepareStandInDatabase({ side: "new", database: db.port, steps: [seedFile("users"), { kind: "command", command: seedCommand }, { kind: "command", command: MIGRATE }], signal: signal() });
    expect(db.log.slice(0, 3)).toEqual(["cmd alembic upgrade head", "sql -- seed:users insert", "cmd npm run seed"]);
    expect(report.migrations).toBe(1); expect(report.seeds).toBe(2);
    expect(db.log[3]).toMatch(/^sql DO \$stand_in\$/u);
  });
  it("leaves a table the seeds filled alone, writes rows to the empty ones (parents first, foreign keys pointing at rows that exist), and says what it did in fixed words", async () => {
    const db = simulated({ migrations: MIGRATIONS });
    const { report } = await prepareStandInDatabase({ side: "old", database: db.port, steps: [{ kind: "command", command: MIGRATE }, seedFile("users")], signal: signal() });
    expect(report.filled).toEqual([{ table: "orgs", rows: 5 }, { table: "posts", rows: 5 }]);
    expect(report.skipped).toEqual([]);
    expect(db.tables.get("users")!.rows).toBe(1);
    const generated = db.sql.at(-1)!;
    expect(generated).not.toContain('INSERT INTO "public"."users"');
    // posts point at the keys the sample read (1 and 2), the rows already there
    expect(generated).toMatch(/INSERT INTO "public"\."posts" \("id", "author_id", "title"\) VALUES \(1, 1, /u);
    expect(JSON.stringify(report)).not.toMatch(/\\/u);
  });
  it("both sides get identical rows for the same schema and seeds; a table the change's migration adds is the only one that differs", async () => {
    const steps: StandInStep[] = [{ kind: "command", command: MIGRATE }, seedFile("users")];
    const a = simulated({ migrations: MIGRATIONS }); const b = simulated({ migrations: MIGRATIONS });
    const old = await prepareStandInDatabase({ side: "old", database: a.port, steps, signal: signal() });
    const changed = await prepareStandInDatabase({ side: "new", database: b.port, steps, signal: signal() });
    expect(b.sql).toEqual(a.sql); expect(changed.report).toEqual({ ...old.report, side: "new" });
    const c = simulated({ migrations: { "alembic upgrade head": [USERS, ORGS, POSTS, LATER] } });
    const withAudit = await prepareStandInDatabase({ side: "new", database: c.port, steps, signal: signal() });
    expect(withAudit.report.filled.map(entry => entry.table).sort()).toEqual([...old.report.filled.map(entry => entry.table), "audit"].sort());
    const blockOf = (sql: string, table: string) => sql.split("\n").find(line => line.includes(`INSERT INTO "public"."${table}"`));
    for (const table of ["orgs", "posts"]) expect(blockOf(c.sql.at(-1)!, table)).toBe(blockOf(a.sql.at(-1)!, table));
    expect(blockOf(c.sql.at(-1)!, "audit")).toBeDefined(); expect(blockOf(a.sql.at(-1)!, "audit")).toBeUndefined();
  });
  it("reports the digests the stand-in version is made from: each seed in load order (a file's bytes, a command's line), never a migration", async () => {
    const db = simulated({ migrations: MIGRATIONS }); const file = seedFile("users"); const seedCommand = command("npm", "run", "seed");
    const { report } = await prepareStandInDatabase({ side: "new", database: db.port, steps: [{ kind: "command", command: MIGRATE }, file, { kind: "command", command: seedCommand }], signal: signal() });
    expect(report.seedDigests).toEqual([seedFileDigest(file.bytes), seedCommandDigest(seedCommand)]);
    expect(report.generatorVersion).toBe(STAND_IN_ROW_GENERATOR_VERSION);
    expect(seedCommandDigest(command("npm", "run", "seed"))).toBe(seedCommandDigest(seedCommand)); expect(seedCommandDigest(command("npm", "run", "seed2"))).not.toBe(seedCommandDigest(seedCommand));
  });
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
  it("a failure carries a fixed sentence: no command text, no path, no database output", async () => {
    const secret = command("npm", "run", "migrate:up", "--token=private-token-value");
    const db = simulated({ failCommand: formatCommandLine(secret) });
    try { await prepareStandInDatabase({ side: "new", database: db.port, steps: [{ kind: "command", command: secret }], signal: signal() }); expect.unreachable(); } catch (error) {
      expect(String(error)).not.toContain("private-token-value"); expect(String(error)).not.toContain("npm"); expect((error as Error).message).toBe("A migration did not complete on the test database");
    }
  });
  it("generated rows are best effort: a refused load leaves the seeds in place, the report says not_filled for those tables and the side still runs", async () => {
    const db = simulated({ migrations: MIGRATIONS, failSql: t => t.startsWith("DO $stand_in$") });
    const { report } = await prepareStandInDatabase({ side: "new", database: db.port, steps: [{ kind: "command", command: MIGRATE }, seedFile("users")], signal: signal() });
    expect(report.filled).toEqual([]); expect(report.skipped).toEqual([{ table: "orgs", reason: "not_filled" }, { table: "posts", reason: "not_filled" }]);
  });
  it("two companies: preparations run side by side share nothing (each port sees only its own data)", async () => {
    const a = simulated({ migrations: MIGRATIONS }); const b = simulated({ migrations: { "alembic upgrade head": [LATER] } });
    const [one, two] = await Promise.all([
      prepareStandInDatabase({ side: "new", database: a.port, steps: [{ kind: "command", command: MIGRATE }], signal: signal() }),
      prepareStandInDatabase({ side: "new", database: b.port, steps: [{ kind: "command", command: MIGRATE }], signal: signal() }),
    ]);
    expect(one.report.filled.map(entry => entry.table).sort()).toEqual(["orgs", "posts", "users"]); expect(two.report.filled.map(entry => entry.table)).toEqual(["audit"]);
    expect(a.sql.join("")).not.toContain("audit"); expect(b.sql.join("")).not.toContain("users");
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
  it("moves when a seed file changes by one byte, an image changes or the seeds' order changes; the baseline then misses the cache", async () => {
    const v = async (seeds: StandInStep[], img = images) => { const r = sharedStandInVersion([await prepare(seeds)], { images: img }); return r.status === "same" ? r.version : r.status; };
    const base = await v([seedFile("users")]);
    expect(await v([seedFile("users", " ")])).not.toBe(base);
    expect(await v([seedFile("users")], ["registry.example/postgres@sha256:" + "2".repeat(64)])).not.toBe(base);
    expect(await v([seedFile("users"), seedFile("orgs")])).not.toBe(await v([seedFile("orgs"), seedFile("users")]));
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
  it("writes the same missing rows to BOTH sides, returns the questions that asked, logs table and column (never a value), and runs once", async () => {
    const old = await prepared("old"); const changed = await prepared("new"); const before = [old.db.sql.length, changed.db.sql.length];
    const log: unknown[] = [];
    const pass = createFillPass({ fillers: [old.filler, changed.filler], signal: signal(), log: entry => log.push(entry),
      observed: async () => [{ questionId: "q1", lookup: { table: "users", column: "email", value: "private-email-value@example.test" }, side: "old" as const }, { questionId: "q2", lookup: { table: "users", column: "email", value: "private-email-value@example.test" }, side: "new" as const }, { questionId: "qx", lookup: { table: "users", column: "id", value: 3 }, side: "old" as const }] });
    expect(await pass({ ids: ["q1", "q2", "q3"] })).toEqual(["q1", "q2"]);
    expect(old.db.sql).toHaveLength(before[0]! + 1); expect(changed.db.sql).toHaveLength(before[1]! + 1);
    expect(old.db.sql.at(-1)).toBe(changed.db.sql.at(-1)); expect(old.db.sql.at(-1)).toContain("'private-email-value@example.test'");
    expect(JSON.stringify(log)).not.toContain("private-email-value"); expect(log).toContainEqual({ event: "stand-in.zero-row-lookup", table: "users", column: "email" });
    // once: a second ask writes nothing and returns nothing
    expect(await pass({ ids: ["q1"] })).toEqual([]); expect(old.db.sql).toHaveLength(before[0]! + 1);
  });
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
  it("fills ONLY keys the old code also asked for: a key only the change looked up (its own possible mistake) is never written, so it cannot hide a regression", async () => {
    const old = await prepared("old"); const changed = await prepared("new"); const before = old.db.sql.length;
    const pass = createFillPass({ fillers: [old.filler, changed.filler], signal: signal(), observed: async () => [
      ...Array.from({ length: 60 }, (_, i) => ({ questionId: "q1", lookup: { table: "users", column: "id", value: 900 + i }, side: "new" as const })),
      { questionId: "q1", lookup: { table: "users", column: "id", value: 777 }, side: "new" as const }, { questionId: "q2", lookup: { table: "users", column: "email", value: "shared@example.test" }, side: "old" as const },
      { questionId: "q2", lookup: { table: "users", column: "email", value: "shared@example.test" }, side: "new" as const }] });
    expect(await pass({ ids: ["q1", "q2"] })).toEqual(["q2"]);
    expect(old.db.sql).toHaveLength(before + 1); expect(old.db.sql.at(-1)).not.toContain("777"); expect(old.db.sql.at(-1)).toContain("shared@example.test");
    const onlyNew = createFillPass({ fillers: [old.filler], signal: signal(), observed: async () => [{ questionId: "q1", lookup: { table: "users", column: "id", value: 778 }, side: "new" as const }] });
    expect(await onlyNew({ ids: ["q1"] })).toEqual([]); expect(old.db.sql).toHaveLength(before + 1);
  });
  it("a logging failure changes nothing", async () => {
    const old = await prepared("old");
    const pass = createFillPass({ fillers: [old.filler], signal: signal(), log: () => { throw new Error("log down"); }, observed: async () => [{ questionId: "q1", lookup: { table: "users", column: "email", value: "a@example.test" }, side: "old" as const }] });
    expect(await pass({ ids: ["q1"] })).toEqual(["q1"]);
  });
});

describe("the port over a started Postgres helper", () => {
  const target = { container: "rovara-svc-run1-postgres", family: "postgres", user: "rovara", database: "app" };
  it("loads SQL through the no-superuser loader and reads as the owner over the local socket; the project's commands run where the caller says", async () => {
    const calls: string[][] = [];
    const docker = { run: vi.fn(async (args: readonly string[]) => { calls.push(["run", ...args]); return { exitCode: 0, stdout: "", stderr: "" }; }),
      execBytes: vi.fn(async (args: readonly string[]) => { calls.push(["exec", ...args]); return { exitCode: 0, stdout: Buffer.from("[]"), stderr: "" }; }) };
    const ran: string[] = [];
    const port = postgresStandInDatabase({ docker, target, runCommand: async cmd => { ran.push(formatCommandLine(cmd)); return { exitCode: 0, timedOut: false }; } });
    await port.runCommand(MIGRATE, signal()); expect(ran).toEqual(["alembic upgrade head"]);
    await port.loadSql(Buffer.from("select 1;"), signal());
    expect(calls.filter(call => call[0] === "run").length).toBeGreaterThanOrEqual(2);
    expect(calls.some(call => call.join(" ").includes("--single-transaction") && call.join(" ").includes("rovara_seed_"))).toBe(true);
    calls.length = 0;
    expect(await port.readText("SELECT 1", signal())).toBe("[]");
    expect(calls).toEqual([["exec", "exec", "rovara-svc-run1-postgres", "psql", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-U", "rovara", "-d", "app", "-c", "SET default_transaction_read_only = on", "-c", "SELECT 1"]]);
  });
});
