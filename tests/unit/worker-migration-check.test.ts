// Proof and evidence P4, migrations: the project's own apply and rollback commands are recognised from their command lines (nothing is added or changed), the migrations a change adds or edits are named from the
// diff, and the tables and columns they touch come from the files in the checked tree as identifiers only. "Applied" needs the project's apply command to have passed in this round; "rolled back" needs a rollback
// command to have passed, and is unknown when the project has none.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceRawSchema, type CheckEntry, type ProjectCommand } from "../../packages/contracts/src/index.js";
import { collectEvidenceRaw, type CollectEvidenceInput } from "../../packages/worker/src/verification/evidence-raw.js";
import { changedMigrationFiles, isMigrationPath, migrationDirectionOf, migrationEvidence, migrationIdOf, schemaChangesOf } from "../../packages/worker/src/verification/migration-check.js";

const run = promisify(execFile);
const DIGEST = "d".repeat(64);
const command = (executable: string, args: string[] = [], cwd = "."): ProjectCommand => ({ executable, args, cwd, timeoutSeconds: 60 });
const entry = (index: number, over: Partial<CheckEntry> = {}): CheckEntry => ({ id: `readiness:${String(index)}`, label: "migrate", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 100, exitCode: 0, ...over });

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "migration-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("which commands apply or roll back migrations", () => {
  const direction = (executable: string, ...args: string[]) => migrationDirectionOf(command(executable, args));
  it("recognises apply commands", () => {
    for (const [executable, args] of [
      ["alembic", ["upgrade", "head"]], ["alembic", ["-c", "db/alembic.ini", "upgrade", "+1"]], ["flask", ["db", "upgrade"]], ["python", ["manage.py", "migrate"]], ["flyway", ["migrate"]],
      ["npx", ["prisma", "migrate", "deploy"]], ["rake", ["db:migrate"]], ["knex", ["migrate:latest"]], ["typeorm", ["migration:run"]], ["goose", ["up"]], ["migrate", ["-path", "m", "up"]],
      ["sqitch", ["deploy"]], ["liquibase", ["update"]], ["dbmate", ["up"]], ["atlas", ["migrate", "apply"]], ["diesel", ["migration", "run"]], ["dotnet", ["ef", "database", "update"]],
    ] as const) expect(direction(executable, ...args), `${executable} ${args.join(" ")}`).toBe("up");
  });
  it("recognises rollback commands before apply commands", () => {
    for (const [executable, args] of [
      ["alembic", ["downgrade", "-1"]], ["flask", ["db", "downgrade"]], ["python", ["manage.py", "migrate", "app", "zero"]], ["flyway", ["undo"]], ["rails", ["db:rollback"]], ["rake", ["db:migrate:down", "VERSION=1"]],
      ["knex", ["migrate:rollback"]], ["typeorm", ["migration:revert"]], ["goose", ["down"]], ["migrate", ["-path", "m", "down"]], ["sqitch", ["revert"]], ["dotnet", ["ef", "database", "update", "0"]],
    ] as const) expect(direction(executable, ...args), `${executable} ${args.join(" ")}`).toBe("down");
  });
  it("names nothing for any other command", () => {
    for (const [executable, args] of [["pytest", ["-q"]], ["eslint", ["."]], ["npm", ["test"]], ["make", ["build"]], ["python", ["-m", "migrations_checker_unrelated_tool_name"]]] as const) expect(direction(executable, ...args)).toBeUndefined();
  });
});

describe("which files are migrations", () => {
  it("knows the usual places, and not tests, init files or documents", () => {
    for (const path of ["db/migrations/0001_init.sql", "app/migrations/0002_add_x.py", "alembic/versions/ab12_users.py", "db/migrate/20260101_create_users.rb", "sql/V3__add_orders.sql", "src/Migrations/001.cs"]) expect(isMigrationPath(path), path).toBe(true);
    for (const path of ["app/migrations/__init__.py", "db/migrations/README.md", "src/models.py", "docs/migrations.md", "tests/test_migrate.py", "migrations.ts"]) expect(isMigrationPath(path), path).toBe(false);
    expect(migrationIdOf("app/migrations/0002_add_x.py")).toBe("0002_add_x");
  });
  it("takes the added and edited migrations of a change, not a deleted one", () => {
    const changes = [
      { path: "db/migrations/1.sql", status: "ADDED" as const, hunks: [] }, { path: "db/migrations/2.sql", status: "MODIFIED" as const, hunks: [] },
      { path: "db/migrations/3.sql", status: "DELETED" as const, hunks: [] }, { path: "src/a.py", status: "MODIFIED" as const, hunks: [] },
    ];
    expect(changedMigrationFiles(changes)).toEqual(["db/migrations/1.sql", "db/migrations/2.sql"]);
  });
});

describe("the tables and columns a migration touches (names only)", () => {
  it("reads SQL, Alembic, Django and Rails forms", () => {
    expect(schemaChangesOf("CREATE TABLE IF NOT EXISTS public.orders (id int);\nALTER TABLE `users` ADD COLUMN age int;\nalter table users drop column legacy;\nDROP TABLE old_things;")).toEqual([
      "create table public.orders", "drop table old_things", "alter table users: add age", "alter table users: drop legacy",
    ]);
    expect(schemaChangesOf("op.create_table('accounts', sa.Column('id'))\nop.add_column('users', sa.Column('age', sa.Integer))\nop.drop_column('users', 'legacy')\nop.drop_table('old')")).toEqual([
      "create table accounts", "drop table old", "alter table users: add age", "alter table users: drop legacy",
    ]);
    expect(schemaChangesOf("migrations.CreateModel(name='Order', fields=[])\nmigrations.AddField(model_name='order', name='note', field=x)")).toEqual(["create table Order", "alter table order: add note"]);
    expect(schemaChangesOf("create_table :orders do |t|\nadd_column :users, :age, :integer")).toEqual(["create table orders", "alter table users: add age"]);
  });
  it("copies identifiers only: no statement, value or comment, and nothing from a file past the size cap", () => {
    const text = "-- DROP TABLE secrets; admin password hunter2\nINSERT INTO users VALUES ('jane.doe@gmail.com');\nCREATE TABLE ok (id int); /* ALTER TABLE x ADD y */";
    const found = schemaChangesOf(text);
    expect(found).toContain("create table ok");
    expect(JSON.stringify(found)).not.toMatch(/hunter2|jane\.doe|INSERT|VALUES/u);
    expect(schemaChangesOf(`${"x".repeat(256 * 1024 + 1)} CREATE TABLE t (id int)`)).toEqual([]);
    expect(schemaChangesOf("CREATE TABLE t1 (a int);\n".repeat(1)).length).toBeLessThanOrEqual(100);
    const many = Array.from({ length: 300 }, (_, index) => `CREATE TABLE t${String(index)} (a int);`).join("\n");
    expect(schemaChangesOf(many)).toHaveLength(100);
  });
});

describe("what the round's outcomes allow to be said", () => {
  const files = ["db/migrations/0001_init.sql", "db/migrations/0002_add.sql"];
  const read = async () => "CREATE TABLE a (id int);";
  const say = (up: CheckEntry | undefined, down: Array<CheckEntry | undefined>, changed = files) => migrationEvidence({ upEntry: up, downEntries: down, changedFiles: changed, readFile: read });
  it("lists the migrations as applied only when the project's apply command passed in this round, and the change touches a migration", async () => {
    expect(await say(entry(0), [])).toEqual({ applied: ["0001_init", "0002_add"], rolledBack: null, schemaChanges: ["create table a"] });
    expect(await say(entry(0, { after: "failed", exitCode: 1 }), [])).toBeUndefined();
    expect(await say(entry(0, { after: "timed_out" }), [])).toBeUndefined();
    expect(await say(undefined, [])).toBeUndefined();
    expect(await say(entry(0), [], [])).toBeUndefined();
  });
  it("says rolled back only when a rollback command passed; failed when one failed; unknown when there is none or it did not finish", async () => {
    expect((await say(entry(0), [entry(1)]))?.rolledBack).toBe(true);
    expect((await say(entry(0), [entry(1), entry(2, { after: "failed" })]))?.rolledBack).toBe(false);
    expect((await say(entry(0), [entry(1, { after: "timed_out" })]))?.rolledBack).toBeNull();
    expect((await say(entry(0), [entry(1), undefined]))?.rolledBack).toBeNull();
    expect((await say(entry(0), []))?.rolledBack).toBeNull();
  });
  it("a file that cannot be read only leaves its tables out", async () => {
    const result = await migrationEvidence({ upEntry: entry(0), downEntries: [], changedFiles: files, readFile: async (path) => { if (path.endsWith("0001_init.sql")) throw new Error("gone"); return "DROP TABLE b;"; } });
    expect(result?.schemaChanges).toEqual(["drop table b"]);
  });
});

describe("the evidence a CHECKS run saves for migrations", () => {
  async function repository(change: (directory: string) => Promise<void>) {
    const directory = join(root, "api");
    const git = async (...args: string[]) => (await run("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: directory })).stdout.trim();
    await mkdir(join(directory, "db/migrations"), { recursive: true });
    await git("init", "-q");
    await writeFile(join(directory, "db/migrations/0001_init.sql"), "CREATE TABLE users (id int);\n");
    await writeFile(join(directory, "app.py"), "print(1)\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "base");
    const base = await git("rev-parse", "HEAD");
    await change(directory);
    await git("add", "-A");
    return [{ repositoryId: "api", directory, startCommit: base, candidateTreeSha: await git("write-tree") }];
  }
  const input = (repositories: Awaited<ReturnType<typeof repository>>, over: Pick<CollectEvidenceInput, "commands" | "entries"> & Partial<CollectEvidenceInput>): CollectEvidenceInput => ({ rootPath: root, candidateDigest: DIGEST, repositories, roundStartedAtMs: Date.now() - 5_000, ...over });

  it("names the migrations the change adds, their tables, and the rollback result, from the project's own commands; the commands are untouched", async () => {
    const repositories = await repository(async (directory) => {
      await writeFile(join(directory, "db/migrations/0002_orders.sql"), "CREATE TABLE orders (id int);\nALTER TABLE users ADD COLUMN age int;\n");
      await writeFile(join(directory, "app.py"), "print(2)\n");
    });
    const commands = [command("alembic", ["upgrade", "head"]), command("alembic", ["downgrade", "-1"])];
    const raw = await collectEvidenceRaw(input(repositories, { commands, entries: [entry(0), entry(1, { label: "rollback" })] }));
    expect(raw?.checks).toHaveLength(1);
    expect(raw?.checks[0]).toMatchObject({ checkId: "readiness:0", migrations: { applied: ["0002_orders"], rolledBack: true, schemaChanges: ["create table orders", "alter table users: add age"] } });
    expect(EvidenceRawSchema.safeParse(raw).success).toBe(true);
    expect(commands[0]?.args).toEqual(["upgrade", "head"]);
  });

  it("says rolled back false when the rollback command failed, and unknown when the project has none", async () => {
    const repositories = await repository(async (directory) => { await writeFile(join(directory, "db/migrations/0002_x.sql"), "CREATE TABLE x (id int);\n"); });
    const failed = await collectEvidenceRaw(input(repositories, { commands: [command("flyway", ["migrate"]), command("flyway", ["undo"])], entries: [entry(0), entry(1, { after: "failed", exitCode: 1 })] }));
    expect(failed?.checks[0]?.migrations?.rolledBack).toBe(false);
    const none = await collectEvidenceRaw(input(repositories, { commands: [command("flyway", ["migrate"])], entries: [entry(0)] }));
    expect(none?.checks[0]?.migrations?.rolledBack).toBeNull();
  });

  it("claims nothing when the apply command failed, the change touches no migration, a repository is missing, or the check is not a migration command", async () => {
    const touching = await repository(async (directory) => { await writeFile(join(directory, "db/migrations/0002_x.sql"), "CREATE TABLE x (id int);\n"); });
    const migrate = [command("alembic", ["upgrade", "head"])];
    expect(await collectEvidenceRaw(input(touching, { commands: migrate, entries: [entry(0, { after: "failed", exitCode: 1 })] }))).toBeUndefined();
    expect(await collectEvidenceRaw(input(touching, { commands: migrate, entries: [entry(0)], repositoriesComplete: false }))).toBeUndefined();
    expect(await collectEvidenceRaw(input(touching, { commands: [command("make", ["build"])], entries: [entry(0)] }))).toBeUndefined();
    await rm(join(root, "api"), { recursive: true, force: true });
    const untouched = await repository(async (directory) => { await writeFile(join(directory, "app.py"), "print(3)\n"); });
    expect(await collectEvidenceRaw(input(untouched, { commands: migrate, entries: [entry(0)] }))).toBeUndefined();
  });
});
