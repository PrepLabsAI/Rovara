// TS-UX-1 item 8: more detection signals. ORM and migration tool configs (knex, sequelize, typeorm, drizzle) name their database; Prisma's seed config, a knex `seeds/` folder and sequelize's `seeders/` folder are seed
// commands; SQL seed files are found by folder and name. Read-only: nothing here runs a command or reads a connection string.
import { describe, expect, it } from "vitest";
import { boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import { seedFilesOf } from "../../packages/worker/src/env-detect/seed-files.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "svc");
}
const family = (detection: Awaited<ReturnType<typeof detect>>, id: string) => detection.dependencies?.find((item) => item.family === id);
const pkg = (body: Record<string, unknown>) => JSON.stringify({ scripts: { test: "vitest run" }, ...body }, null, 2);

describe("ORM and migration tool configs", () => {
  it("reads the knexfile's client", async () => {
    const detection = await detect({ "knexfile.js": "module.exports = {\n  test: {\n    client: 'pg',\n    connection: process.env.X_CONN,\n  },\n};\n" });
    expect(family(detection, "postgres")).toMatchObject({ kind: "database", evidence: [{ path: "knexfile.js", line: 3 }], hints: { seenBy: ["orm"] } });
  });
  it("reads sequelize's dialect, typeorm's type and drizzle's dialect", async () => {
    expect(family(await detect({ "config/config.json": JSON.stringify({ test: { dialect: "mysql", host: "127.0.0.1" } }, null, 2) }), "mysql")).toBeDefined();
    expect(family(await detect({ "ormconfig.json": JSON.stringify({ type: "postgres" }) }), "postgres")).toBeDefined();
    expect(family(await detect({ "src/data-source.ts": "export const ds = new DataSource({ type: \"mariadb\", url: process.env.X_URL });" }), "mariadb")).toBeDefined();
    expect(family(await detect({ "drizzle.config.ts": "export default defineConfig({ dialect: 'postgresql', schema: './s.ts' });" }), "postgres")).toBeDefined();
    expect(family(await detect({ "drizzle.config.ts": "export default { driver: 'mysql2' };" }), "mysql")).toBeDefined();
  });
  it("gives nothing for SQLite, for a commented-out dialect, or for the word in another file (positive control above)", async () => {
    expect((await detect({ "knexfile.js": "module.exports = { client: 'sqlite3' };" })).dependencies).toBeUndefined();
    expect((await detect({ "knexfile.js": "// client: 'pg'\nmodule.exports = {};" })).dependencies).toBeUndefined();
    expect((await detect({ "src/notes.ts": "const client = 'pg';" })).dependencies).toBeUndefined();
  });
  it("lets a bare DATABASE_URL go to the database the ORM config names", async () => {
    const detection = await detect({ "knexfile.ts": "export default { client: 'mysql2' };", "src/db.ts": "export const url = process.env.DATABASE_URL;\n" });
    expect(family(detection, "mysql")!.hints.envNames).toEqual(["DATABASE_URL"]);
    expect(family(detection, "postgres")).toBeUndefined();
  });
});

describe("seed commands the database tools know of", () => {
  it("Prisma's seed config is `npx prisma db seed`, cited at the prisma key", async () => {
    const detection = await detect({ "package.json": pkg({ prisma: { seed: "ts-node prisma/seed.ts" } }) });
    expect(detection.seedCommands).toEqual([{ value: { cwd: "svc", executable: "npx", args: ["prisma", "db", "seed"], timeoutSeconds: 900 }, source: { path: "package.json", line: 5 } }]);
  });
  it("a knex seeds folder is `npx knex seed:run`; sequelize seeders are `npx sequelize-cli db:seed:all`", async () => {
    expect((await detect({ "package.json": pkg({ dependencies: { knex: "3" } }), "seeds/01_users.js": "exports.seed = () => {};" })).seedCommands?.[0]?.value.args).toEqual(["knex", "seed:run"]);
    expect((await detect({ "package.json": pkg({ devDependencies: { "sequelize-cli": "6" } }), "db/seeders/1-users.js": "" })).seedCommands?.[0]?.value.args).toEqual(["sequelize-cli", "db:seed:all"]);
  });
  it("needs the tool AND the folder, and a seed script still wins", async () => {
    expect((await detect({ "package.json": pkg({}), "seeds/01_users.js": "" })).seedCommands).toBeUndefined();
    expect((await detect({ "package.json": pkg({ dependencies: { knex: "3" } }) })).seedCommands).toBeUndefined();
    const both = await detect({ "package.json": pkg({ scripts: { test: "vitest", seed: "node seed.js" }, prisma: { seed: "x" } }) });
    expect(both.seedCommands?.map((item) => item.value.args)).toEqual([["run", "seed"]]);
  });
});

describe("SQL seed files", () => {
  it("finds .sql files in seed folders and files named for a seed", () => {
    expect(seedFilesOf(["db/seeds/users.sql", "seed.sql", "data/test-seed.sql", "sql/users.seed.sql", "seeds/nested/a.sql"]).map((item) => item.value)).toEqual(["data/test-seed.sql", "db/seeds/users.sql", "seed.sql", "seeds/nested/a.sql"]);
  });
  it("leaves out migrations, tests' own fixtures, other files and words that only contain seed", () => {
    expect(seedFilesOf(["migrations/seed.sql", "tests/seed.sql", "seeds/users.js", "schema.sql", "seedling.sql", "node_modules/x/seed.sql"])).toEqual([]);
  });
  it("does not offer a pg_dump-style COPY ... FROM stdin file (or one with a psql command), and says why", async () => {
    const { SEED_FILE_DUMP_NOTE } = await import("../../packages/worker/src/env-detect/seed-files.js");
    const detection = await detect({ "package.json": pkg({}), "db/seeds/dump.sql": "COPY public.users (id) FROM stdin;\n1\n\\.\n", "db/seeds/plain.sql": "insert into users values (1);" });
    expect(detection.seedFiles?.map((item) => item.value)).toEqual(["db/seeds/plain.sql"]);
    expect(detection.notes).toContain(SEED_FILE_DUMP_NOTE);
  });
  it("reports them on the detection, cited at the file", async () => {
    const detection = await detect({ "package.json": pkg({}), "db/seeds/users.sql": "insert into users values (1);" });
    expect(detection.seedFiles).toEqual([{ value: "db/seeds/users.sql", source: { path: "db/seeds/users.sql", line: 1 } }]);
  });
});
