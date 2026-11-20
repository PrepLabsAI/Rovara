// L4-EINT: the stand-in writer's two readers are real (E7's seams, E3's tables and E6's operations): tracked files only, shapes only, no link followed, bounded, and the operation names the writer is asked for are the very names the
// stand-in's pools are joined by.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { standInOperationId, standInPoolRoutes, buildOpenApiFake, type StandInWriterSet } from "@agentx/contracts";
import { openApiHostOf, readOperationSeams, readTableSeams, tablesOfSql } from "../../packages/worker/src/standin-readers.js";
import { standInRequestOf } from "../../packages/worker/src/standin-shapes.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const OPENAPI = { openapi: "3.0.3", info: { title: "t", version: "1" }, servers: [{ url: "https://api.tiktok.com/v2" }], paths: {
  "/user/info": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["data"], properties: { data: { type: "object", properties: { display_name: { type: "string" }, followers: { type: "integer" } } } } } } } } } } },
} };
async function repo(files: Record<string, string>) {
  const directory = await mkdtemp(join(process.env["TMPDIR"] ?? process.cwd(), "eint-readers-")); roots.push(directory);
  for (const [path, text] of Object.entries(files)) { await mkdir(join(directory, path, ".."), { recursive: true }); await writeFile(join(directory, path), text); }
  const repository = { name: "web", directory } as never;
  const tracked = new Map([["web", new Set(Object.keys(files))]]);
  return { repository, tracked, directory };
}

describe("tables: the repository's own SQL, names and kinds only", () => {
  it("reads CREATE TABLE statements: kinds, keys (primary and foreign), a char limit, and nothing else", () => {
    const tables = tablesOfSql(`CREATE TABLE IF NOT EXISTS public.creators (
      id integer PRIMARY KEY, handle varchar(40) NOT NULL, bio text, followers bigint DEFAULT 0, joined_at timestamptz, verified boolean,
      brand_id integer REFERENCES brands(id), CONSTRAINT creators_u UNIQUE (handle), FOREIGN KEY (brand_id) REFERENCES brands(id)
    ); CREATE TABLE brands (id serial, name text, PRIMARY KEY (id));`);
    expect(tables.map((table) => table.name)).toEqual(["creators", "brands"]);
    const creators = tables[0]!;
    expect(creators.columns.map((column) => [column.name, column.kind, column.key])).toEqual([
      ["id", "integer", true], ["handle", "text", false], ["bio", "text", false], ["followers", "integer", false], ["joined_at", "timestamp", false], ["verified", "boolean", false], ["brand_id", "integer", true],
    ]);
    expect(creators.columns[1]).toMatchObject({ maxChars: 40 });
    expect(tables[1]!.columns.find((column) => column.name === "id")).toMatchObject({ key: true });
    // No value can be in a seam: there is no field for one.
    expect(JSON.stringify(tables)).not.toMatch(/INSERT|VALUES/iu);
  });
  it("is bounded and total: unbalanced SQL, an enormous statement and many tables give a bounded answer and never throw", () => {
    expect(tablesOfSql("CREATE TABLE a (id int, ")).toEqual([]);
    expect(tablesOfSql("CREATE TABLE a (" + "x int,".repeat(100_000) + " y int)")).toEqual([]);
    expect(tablesOfSql(Array.from({ length: 200 }, (_, i) => `CREATE TABLE t${String(i)} (id int);`).join("\n")).length).toBeLessThanOrEqual(64);
    expect(tablesOfSql("")).toEqual([]);
  });
  it("reads only TRACKED .sql files, not through a link, and not node_modules", async () => {
    const r = await repo({ "db/schema.sql": "CREATE TABLE creators (id int primary key, name text);", "node_modules/x/dump.sql": "CREATE TABLE hidden (id int);" });
    await symlink("/etc/hosts", join(r.directory, "db", "link.sql"));
    const tracked = new Map([["web", new Set(["db/schema.sql", "db/link.sql", "node_modules/x/dump.sql"])]]);
    await writeFile(join(r.directory, "db", "untracked.sql"), "CREATE TABLE untracked (id int);");
    const seams = await readTableSeams([r.repository], tracked);
    expect(seams.map((table) => table.name)).toEqual(["creators"]);
  });
});

describe("operations: the OpenAPI description's operations, by the host its servers name, with the shape of the example answer", () => {
  it("reads the host and the operations of a tracked description; an operation id is the one the pools are joined by", async () => {
    expect(openApiHostOf(OPENAPI)).toBe("api.tiktok.com");
    expect(openApiHostOf({ servers: [{ url: "http://insecure.example.test" }, { url: "https://localhost" }, { url: "https://10.0.0.1" }] })).toBeUndefined();
    const r = await repo({ "api/openapi.json": JSON.stringify(OPENAPI) });
    const operations = await readOperationSeams([r.repository], r.tracked);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ host: "api.tiktok.com", method: "GET", path: "/user/info", id: standInOperationId("GET", "api.tiktok.com", "/user/info") });
    const request = await standInRequestOf([r.repository], r.tracked);
    expect(request?.operations.map((operation) => operation.id)).toEqual([operations[0]!.id]);
    expect(request?.operations[0]?.fields.map((field) => field.path)).toEqual(["data.display_name", "data.followers"]);
    // The same name joins the writer's answers to the stand-in's operation.
    const fake = buildOpenApiFake(OPENAPI, "openapi.json");
    if (fake.status !== "built") throw new Error("fixture");
    const set: StandInWriterSet = { schemaVersion: 1, writer: "rovara-standin-writer/1", requestDigest: "a".repeat(64), tables: {}, answers: { [operations[0]!.id]: [{ data: { display_name: "Maya", followers: 3 } }] } };
    expect(standInPoolRoutes("api.tiktok.com", fake, set)).toEqual([{ method: "GET", template: "/user/info", answers: [{ data: { display_name: "Maya", followers: 3 } }] }]);
    expect(standInPoolRoutes("api.other.test", fake, set)).toEqual([]);
  });
});
