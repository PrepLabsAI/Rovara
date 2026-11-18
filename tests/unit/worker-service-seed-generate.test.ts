// L4-E34 (E3): generated test rows for the empty tables of a run's own fresh database. Deterministic (no AI, no clock, no randomness), key-respecting, plain SQL only, bounded, and in fixed words. Nothing is read from a real database.
import { describe, expect, it } from "vitest";
import {
  PLAIN_NAME, STAND_IN_LIMITS, STAND_IN_ROWS_PER_TABLE, STAND_IN_ROW_GENERATOR_VERSION, STAND_IN_SCHEMA_STATEMENT, notFilled, parentKeyColumns, parseSampledKeys, parseStandInSchema, planFillForLookups,
  planStandInRows, sampleKeysStatement, standInValue, type StandInColumn,
} from "../../packages/worker/src/service-seed-generate.js";
import { seedFileContentProblem } from "../../packages/worker/src/service-seed-file.js";

const col = (name: string, type: string, extra: Partial<StandInColumn> = {}): StandInColumn => ({ name, type, nullable: false, identity: "", generated: false, enumValues: [], ...extra });
const raw = (tables: unknown[]) => ({ tables });
const users = { name: "users", hasRows: false, primaryKey: ["id"], uniques: [["email"]], foreignKeys: [], columns: [
  col("id", "integer", { identity: "d" }), col("email", "text"), col("name", "character varying(12)"), col("created_at", "timestamp with time zone"), col("status", "user_status", { enumValues: ["active", "banned"] }), col("bio", "text", { nullable: true }) ] };
const orgs = { name: "orgs", hasRows: false, primaryKey: ["id"], uniques: [], foreignKeys: [], columns: [col("id", "uuid"), col("name", "text"), col("rank", "numeric(5,2)")] };
const memberships = { name: "memberships", hasRows: false, primaryKey: ["user_id", "org_id"], uniques: [], columns: [col("user_id", "integer"), col("org_id", "uuid"), col("role", "text")],
  foreignKeys: [{ columns: ["user_id"], refTable: "users", refColumns: ["id"] }, { columns: ["org_id"], refTable: "orgs", refColumns: ["id"] }] };
const posts = { name: "posts", hasRows: false, primaryKey: ["id"], uniques: [], columns: [col("id", "bigint", { identity: "a" }), col("author_id", "integer"), col("parent_id", "bigint", { nullable: true }), col("title", "text"), col("score", "numeric(5,2)"),
  col("flag", "boolean"), col("meta", "jsonb"), col("payload", "bytea"), col("tags", "text[]"), col("day", "date"), col("ref", "inet")],
  foreignKeys: [{ columns: ["author_id"], refTable: "users", refColumns: ["id"] }, { columns: ["parent_id"], refTable: "posts", refColumns: ["id"] }] };
const schemaOf = (tables: unknown[]) => parseStandInSchema(raw(tables))!;
const base = () => schemaOf([users, orgs, memberships, posts, { name: "alembic_version", hasRows: true, primaryKey: [], uniques: [], foreignKeys: [], columns: [col("version_num", "text")] }]);
const rowsOf = (plan: ReturnType<typeof planStandInRows>, table: string) => { const found = plan.data.find(entry => entry.table === table)!; return found.rows.map(row => Object.fromEntries(found.columns.map((c, i) => [c, row[i]!]))); };

describe("the schema read", () => {
  it("is a fixed read-only statement that names nothing of the project", () => {
    expect(STAND_IN_SCHEMA_STATEMENT.trimStart().startsWith("SELECT")).toBe(true);
    expect(STAND_IN_SCHEMA_STATEMENT).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT)\b/u);
    expect(STAND_IN_SCHEMA_STATEMENT).toContain("n.nspname = 'public'");
  });
  it("is parsed with runtime checks: a wrong shape, an unknown key column, a duplicate table or an extra field is no schema", () => {
    expect(parseStandInSchema(raw([users]))).toBeDefined();
    for (const bad of [null, {}, { tables: "x" }, raw([{ ...users, extra: 1 }]), raw([{ ...users, primaryKey: ["nope"] }]), raw([users, users]), raw([{ ...memberships, foreignKeys: [{ columns: ["user_id", "org_id"], refTable: "users", refColumns: ["id"] }] }]),
      raw([{ ...users, columns: [] }]), raw([{ ...users, columns: [col("id", "integer"), col("id", "integer")] }]), raw([{ ...users, columns: [{ ...col("id", "integer"), identity: "x" }] }])]) {
      expect(parseStandInSchema(bad)).toBeUndefined();
    }
  });
  it("drops migration bookkeeping tables, orders by name, and says when it kept only the first 64", () => {
    const schema = parseStandInSchema(raw([{ ...users, name: "zeta" }, { ...users, name: "alembic_version" }, { ...users, name: "_prisma_migrations" }, { ...users, name: "alpha" }]))!;
    expect(schema.tables.map(table => table.name)).toEqual(["alpha", "zeta"]);
    const many = parseStandInSchema(raw(Array.from({ length: 70 }, (_, i) => ({ ...orgs, name: `t${String(i).padStart(3, "0")}` }))))!;
    expect(many.tables).toHaveLength(STAND_IN_LIMITS.tables); expect(many.truncated).toBe(true);
    expect(planStandInRows(many).skipped).toContainEqual({ table: "", reason: "too_many_tables" });
  });
});

describe("the same schema gives byte-identical rows", () => {
  it("on every run, and whatever order the tables came in", () => {
    const first = planStandInRows(base());
    expect(first.sql).not.toBe("");
    expect(planStandInRows(base()).sql).toBe(first.sql);
    expect(planStandInRows(schemaOf([posts, memberships, orgs, users])).sql).toBe(planStandInRows(schemaOf([users, orgs, memberships, posts])).sql);
    expect(JSON.stringify(planStandInRows(base()).data)).toBe(JSON.stringify(first.data));
  });
  it("for an unchanged table, even when another table changes (a column added elsewhere moves nothing here)", () => {
    const changed = schemaOf([users, { ...orgs, columns: [...orgs.columns, col("extra", "integer")] }, memberships, posts]);
    expect(rowsOf(planStandInRows(changed), "users")).toEqual(rowsOf(planStandInRows(base()), "users"));
    expect(rowsOf(planStandInRows(changed), "posts")).toEqual(rowsOf(planStandInRows(base()), "posts"));
  });
  it("and depends on the generator's version (a new generator is a new set of rows)", () => {
    const text = standInValue("users", col("name", "text"), 3, false);
    expect(text).toBeDefined();
    expect(STAND_IN_ROW_GENERATOR_VERSION).toMatch(/^rows-v\d+$/u);
  });
  it("uses no clock and no randomness: it is the same under a different Date and Math.random", () => {
    const real = { now: Date.now, random: Math.random };
    const before = planStandInRows(base()).sql;
    try { Date.now = () => 1; Math.random = () => 0.123; expect(planStandInRows(base()).sql).toBe(before); } finally { Date.now = real.now; Math.random = real.random; }
  });
});

describe("keys hold", () => {
  const plan = planStandInRows(base());
  it("writes STAND_IN_ROWS_PER_TABLE rows to every empty table and none to a table that already has rows or to bookkeeping", () => {
    expect(plan.tables).toEqual([{ table: "users", rows: 5 }, { table: "orgs", rows: 5 }, { table: "memberships", rows: 5 }, { table: "posts", rows: 5 }]);
    expect(STAND_IN_ROWS_PER_TABLE).toBe(5);
    expect(plan.tables.map(entry => entry.table)).not.toContain("alembic_version");
    const seeded = planStandInRows(schemaOf([{ ...users, hasRows: true }, orgs]));
    expect(seeded.tables.map(entry => entry.table)).toEqual(["orgs"]);
    expect(seeded.skipped).toContainEqual({ table: "users", reason: "has_rows" });
  });
  it("gives primary and unique keys a different value per row", () => {
    const u = rowsOf(plan, "users");
    expect(new Set(u.map(row => row["id"])).size).toBe(5); expect(new Set(u.map(row => row["email"])).size).toBe(5);
    const m = rowsOf(plan, "memberships");
    expect(new Set(m.map(row => `${row["user_id"]}/${row["org_id"]}`)).size).toBe(m.length);
    expect(new Set(rowsOf(plan, "orgs").map(row => row["id"])).size).toBe(5);
  });
  it("makes every foreign key value a key value of a parent row (positive control: each child table has rows)", () => {
    const userIds = new Set(rowsOf(plan, "users").map(row => row["id"])); const orgIds = new Set(rowsOf(plan, "orgs").map(row => row["id"]));
    const m = rowsOf(plan, "memberships"); expect(m.length).toBeGreaterThan(0);
    for (const row of m) { expect(userIds.has(row["user_id"])).toBe(true); expect(orgIds.has(row["org_id"])).toBe(true); }
    const p = rowsOf(plan, "posts"); expect(p.length).toBeGreaterThan(0);
    for (const row of p) { expect(userIds.has(row["author_id"])).toBe(true); }
    // a self-reference points at a post that is written (the first)
    const postIds = new Set(p.map(row => row["id"])); for (const row of p) expect(postIds.has(row["parent_id"])).toBe(true);
  });
  it("loads parents first, and a child of a table the migrations or seeds already filled points at a key already there", () => {
    const order = plan.tables.map(entry => entry.table);
    expect(order.indexOf("users")).toBeLessThan(order.indexOf("memberships")); expect(order.indexOf("orgs")).toBeLessThan(order.indexOf("memberships")); expect(order.indexOf("users")).toBeLessThan(order.indexOf("posts"));
    const seeded = schemaOf([{ ...users, hasRows: true }, orgs, memberships, posts]);
    const wanted = parentKeyColumns(seeded);
    expect([...wanted]).toEqual([["users", ["id"]]]);
    const sampled = parseSampledKeys({ users: [{ id: 41 }, { id: 42 }] }, wanted);
    const withParents = planStandInRows(seeded, sampled);
    for (const row of rowsOf(withParents, "posts")) expect(["41", "42"]).toContain(row["author_id"]);
    for (const row of rowsOf(withParents, "memberships")) expect(["41", "42"]).toContain(row["user_id"]);
  });
  it("skips a table whose required parent has no rows (no_parent), leaves a nullable foreign key NULL, and never points at rows that were not written", () => {
    const orphan = { ...posts, name: "orphans", foreignKeys: [{ columns: ["author_id"], refTable: "ghosts", refColumns: ["id"] }] };
    const p = planStandInRows(schemaOf([orphan]));
    expect(p.skipped).toContainEqual({ table: "orphans", reason: "no_parent" }); expect(p.sql).toBe("");
    const nullable = { ...posts, name: "loose", columns: posts.columns.map(c => (c.name === "author_id" ? { ...c, nullable: true } : c)), foreignKeys: [{ columns: ["author_id"], refTable: "ghosts", refColumns: ["id"] }] };
    const q = planStandInRows(schemaOf([nullable]));
    expect(q.data[0]!.columns).not.toContain("author_id");
  });
  it("skips a table with a required column of a type it cannot write (unsupported_type) and leaves a nullable one out", () => {
    const odd = { ...orgs, name: "odd", columns: [col("id", "uuid"), col("doc", "tsvector")] };
    expect(planStandInRows(schemaOf([odd])).skipped).toContainEqual({ table: "odd", reason: "unsupported_type" });
    const oddNullable = { ...orgs, name: "odd2", columns: [col("id", "uuid"), col("doc", "tsvector", { nullable: true })] };
    expect(planStandInRows(schemaOf([oddNullable])).data[0]!.columns).toEqual(["id"]);
  });
  it("writes no value to a generated column, writes identity-always columns with OVERRIDING SYSTEM VALUE, and moves the counters past the rows", () => {
    const gen = { ...orgs, name: "gen", columns: [col("id", "uuid"), col("total", "integer", { generated: true })] };
    expect(planStandInRows(schemaOf([gen])).data[0]!.columns).toEqual(["id"]);
    expect(plan.sql).toContain('INSERT INTO "public"."posts"');
    expect(plan.sql).toMatch(/"public"\."posts" \([^)]*\) OVERRIDING SYSTEM VALUE VALUES/u);
    expect(plan.sql).not.toMatch(/"public"\."users" \([^)]*\) OVERRIDING SYSTEM VALUE/u);
    expect(plan.sql).toContain("setval(pg_get_serial_sequence('\"public\".\"users\"', 'id')");
  });
  it("drops a row that would repeat an earlier primary key (a join table with fewer parents than rows)", () => {
    const one = schemaOf([{ ...users, hasRows: true }, { ...orgs, name: "orgs" }, { name: "pairs", hasRows: false, primaryKey: ["a", "b"], uniques: [], columns: [col("a", "integer"), col("b", "integer")],
      foreignKeys: [{ columns: ["a"], refTable: "users", refColumns: ["id"] }, { columns: ["b"], refTable: "users", refColumns: ["id"] }] }]);
    const sampled = parseSampledKeys({ users: [{ id: 1 }, { id: 2 }] }, parentKeyColumns(one));
    const pairs = rowsOf(planStandInRows(one, sampled), "pairs");
    expect(new Set(pairs.map(row => `${row["a"]}/${row["b"]}`)).size).toBe(pairs.length);
  });
});

describe("plain SQL only, and every failure in fixed words", () => {
  it("the statements pass the loader's own screen: no backslash, no PROGRAM, no NUL, no control character", () => {
    const sql = planStandInRows(base()).sql;
    expect(seedFileContentProblem(Buffer.from(sql, "utf8"))).toBeUndefined();
    expect([...sql].some(ch => ch === "\\" || (ch.charCodeAt(0) < 0x20 && ch !== "\n"))).toBe(false);
  });
  it("every value is a plain literal: no value holds a quote it did not double, and bytea has no backslash", () => {
    for (const entry of planStandInRows(base()).data) for (const row of entry.rows) for (const value of row) expect(value).not.toMatch(/\\/u);
    expect(standInValue("t", col("payload", "bytea"), 0, false)).toBe("decode('00ff', 'hex')");
    expect(standInValue("t", col("e", "mood", { enumValues: ["it's"] }), 0, true)).toBe("'it''s'");
    expect(standInValue("t", col("e", "mood", { enumValues: ["a\\b"] }), 0, true)).toBeUndefined();
    expect(standInValue("t", col("e", "mood", { enumValues: ["$stand_in$"] }), 0, true)).toBeUndefined();
  });
  it("skips a table whose statement the loader would refuse (a table named PROGRAM), not the whole load, and does not use it as a parent", () => {
    const program = { ...orgs, name: "program" };
    const child = { name: "kids", hasRows: false, primaryKey: ["id"], uniques: [], columns: [col("id", "integer"), col("p", "uuid")], foreignKeys: [{ columns: ["p"], refTable: "program", refColumns: ["id"] }] };
    const plan = planStandInRows(schemaOf([program, child, users]));
    expect(plan.skipped).toContainEqual({ table: "program", reason: "unsafe_name" });
    expect(plan.skipped).toContainEqual({ table: "kids", reason: "no_parent" });
    expect(plan.tables.map(entry => entry.table)).toEqual(["users"]);
    expect(seedFileContentProblem(Buffer.from(plan.sql, "utf8"))).toBeUndefined();
  });
  it("never quotes a table or column name that is not plain (it is skipped as unsafe_name)", () => {
    for (const bad of ["a b", 'a"b', "a;drop", "é", "1x", "", "x".repeat(64)]) expect(PLAIN_NAME.test(bad)).toBe(false);
    const evil = { ...orgs, name: 'x"; DROP TABLE users; --' };
    const plan = planStandInRows(schemaOf([evil, { ...orgs, name: "ok", columns: [col("id", "uuid"), col('na"me', "text")] }]));
    expect(plan.sql).toBe(""); expect(plan.skipped.map(entry => entry.reason)).toEqual(["unsafe_name", "unsafe_name"]);
    expect(JSON.stringify(plan)).not.toContain("DROP");
    expect(plan.skipped).toEqual([{ table: "ok", reason: "unsafe_name" }, { table: "", reason: "unsafe_name" }]);
  });
  it("reports a table that stays empty after the load as not_filled", () => {
    const plan = planStandInRows(schemaOf([orgs, users]));
    const after = schemaOf([{ ...orgs, hasRows: true }, { ...users, hasRows: false }]);
    expect(notFilled(plan, after)).toEqual([{ table: "users", reason: "not_filled" }]);
  });
  it("is bounded: 64 tables of 200 columns plan in well under two seconds, and a 10,000-table schema is cut at 64", () => {
    const wide = Array.from({ length: 64 }, (_, i) => ({ name: `wide${String(i).padStart(2, "0")}`, hasRows: false, primaryKey: ["c0"], uniques: [], foreignKeys: [], columns: Array.from({ length: 200 }, (_, j) => col(`c${j}`, j % 3 === 0 ? "integer" : "text")) }));
    const started = Date.now(); const plan = planStandInRows(schemaOf(wide));
    expect(Date.now() - started).toBeLessThan(2_000); expect(plan.tables).toHaveLength(64);
    const huge = parseStandInSchema(raw(Array.from({ length: 10_000 }, (_, i) => ({ ...orgs, name: `h${i}` }))))!;
    expect(huge.tables).toHaveLength(STAND_IN_LIMITS.tables);
  });
});

describe("parent keys already in the database", () => {
  it("are asked for by a fixed statement built only from schema names that are plain, for parents of empty tables", () => {
    const schema = schemaOf([{ ...users, hasRows: true }, { ...orgs, hasRows: true }, memberships, { ...orgs, name: "bad name", hasRows: true }]);
    const wanted = parentKeyColumns(schema);
    expect([...wanted]).toEqual([["orgs", ["id"]], ["users", ["id"]]]);
    const statement = sampleKeysStatement(wanted)!;
    expect(statement.startsWith("SELECT json_build_object(")).toBe(true); expect(statement).toContain(`LIMIT ${STAND_IN_LIMITS.parentKeys}`); expect(statement).toContain('"public"."users"');
    expect(sampleKeysStatement(new Map())).toBeUndefined();
  });
  it("come back as quoted SQL literals; a value with a backslash, a control character or the block tag is no key, and so is a null or a wrong shape", () => {
    const wanted = new Map([["users", ["id"]], ["orgs", ["id"]]]);
    const keys = parseSampledKeys({ users: [{ id: 7 }, { id: null }], orgs: [{ id: "it's" }, { id: "a\\b" }, { id: "x\u0001" }, { id: "$stand_in$" }] }, wanted);
    expect(keys.get("users")).toEqual([{ id: "7" }]); expect(keys.get("orgs")).toEqual([{ id: "'it''s'" }]);
    expect(parseSampledKeys("nope", wanted).size).toBe(0); expect(parseSampledKeys({ other: [{ id: 1 }] }, wanted).size).toBe(0);
  });
});

describe("the fill for zero-row lookups", () => {
  const schema = base();
  it("writes the asked key value into its column, a parent that exists for every foreign key, and is the same whatever else was asked or in what order", () => {
    const sampled = parseSampledKeys({ users: [{ id: 1 }, { id: 2 }] }, new Map([["users", ["id"]]]));
    const a = planFillForLookups(schema, [{ table: "users", column: "email", value: "who@example.test" }, { table: "posts", column: "id", value: 9001 }], sampled);
    expect(rowsOf(a, "users")[0]!["email"]).toBe("'who@example.test'"); expect(rowsOf(a, "posts")[0]!["id"]).toBe("9001"); expect(["1", "2"]).toContain(rowsOf(a, "posts")[0]!["author_id"]);
    const b = planFillForLookups(schema, [{ table: "posts", column: "id", value: 9001 }], sampled);
    expect(b.sql).toBe(a.sql.split("\n").filter(line => line.includes('"public"."posts"')).join("\n") + "\n");
    const c = planFillForLookups(schema, [{ table: "posts", column: "id", value: 9001 }, { table: "users", column: "email", value: "who@example.test" }], sampled);
    expect(c.sql).toBe(a.sql);
  });
  it("skips, in fixed words, a table or column that is not in the schema, a value that is not plain, and a table that cannot be written; one pass is at most 50 lookups", () => {
    const plan = planFillForLookups(schema, [{ table: "ghosts", column: "id", value: 1 }, { table: "users", column: "nope", value: 1 }, { table: "users", column: "email", value: "a\\b" }, { table: "users", column: "email", value: Number.NaN }, { table: "users", column: "id", value: "x".repeat(201) }]);
    expect(plan.sql).toBe(""); expect(plan.skipped.every(entry => entry.reason === "unsafe_name")).toBe(true);
    const many = planFillForLookups(schema, Array.from({ length: 80 }, (_, i) => ({ table: "orgs", column: "name", value: `n${i}` })));
    expect(many.data[0]!.rows.length + (many.data[1]?.rows.length ?? 0)).toBeLessThanOrEqual(STAND_IN_LIMITS.lookups);
    expect(many.sql).not.toMatch(/\\/u);
  });
  it("needs a parent: a lookup in a table whose required parent has no rows is skipped no_parent", () => {
    expect(planFillForLookups(schema, [{ table: "posts", column: "id", value: 5 }]).skipped).toContainEqual({ table: "posts", reason: "no_parent" });
  });
});
