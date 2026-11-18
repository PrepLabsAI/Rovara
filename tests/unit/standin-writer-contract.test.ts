// L4-E7: the stand-in writer's contract. The request is SHAPES ONLY (never a row, a change or a task), the reply fits it whole or is refused, a stored set is pinned by a digest, and the cost has a ceiling known before the run.
import { describe, expect, it } from "vitest";
import {
  STANDIN_LIMITS, STANDIN_WRITER_WORDS, StandInWriterInputSchema, StandInWriterSetSchema, buildStandInRequest, parseStandInWriterOutput, pickStandInIndex,
  standInFieldsOf, standInRequestDigest, standInSetDigest, standInVersionPart, standInWriterCard, standInReferencePrice, standInWriterCeilingCents, standInWriterEstimateCents,
  type StandInWriterInput,
} from "../../packages/contracts/src/index.js";

const input = (over: Partial<StandInWriterInput> = {}): StandInWriterInput => StandInWriterInputSchema.parse({
  tables: [{
    name: "creators", rows: 3,
    columns: [
      { name: "id", kind: "integer", key: true, writable: false },
      { name: "handle", kind: "text", key: false, writable: true, maxChars: 30 },
      { name: "bio", kind: "text", key: false, writable: true, maxChars: 200 },
      { name: "followers", kind: "integer", key: false, writable: true },
      { name: "tier", kind: "text", key: false, writable: true, oneOf: ["nano", "micro", "macro"] },
      { name: "joined_at", kind: "timestamp", key: false, writable: true },
    ],
  }],
  operations: [{
    id: "tiktok-user", host: "open.tiktokapis.com", method: "GET", path: "/v2/user/info", answers: 2,
    fields: [{ path: "data.user.display_name", kind: "string", required: true }, { path: "data.user.follower_count", kind: "integer", required: true }, { path: "data.user.videos[].title", kind: "string", required: false }],
  }],
  ...over,
});
const goodReply = {
  tables: { creators: [
    { handle: "mara_codes", bio: "Weekend baker and former line cook sharing quick recipes.", followers: 12044, tier: "micro", joined_at: "2025-03-02T10:00:00Z" },
    { handle: "kofi.travels", bio: "Slow travel around West Africa.", followers: 880, tier: "nano", joined_at: "2024-11-19T08:30:00Z" },
  ] },
  answers: { "tiktok-user": [
    { data: { user: { display_name: "Mara Okafor", follower_count: 12044, videos: [{ title: "Sourdough in 10 minutes" }] } } },
    { data: { user: { display_name: "Kofi Mensah", follower_count: 880 } } },
  ] },
};
const parse = (reply: unknown, request: StandInWriterInput = input()) => parseStandInWriterOutput(typeof reply === "string" ? reply : JSON.stringify(reply), request);

describe("the request is shapes only (N5)", () => {
  it("accepts names, kinds and shapes", () => expect(input().tables[0]!.columns).toHaveLength(6));
  it("refuses a row, a value, a diff or a task anywhere in it (strict)", () => {
    const base = JSON.parse(JSON.stringify(input())) as Record<string, unknown>;
    const tables = base["tables"] as Array<Record<string, unknown>>;
    expect(StandInWriterInputSchema.safeParse({ ...base, diff: "--- a/x" }).success).toBe(false);
    expect(StandInWriterInputSchema.safeParse({ ...base, task: "fix the bug" }).success).toBe(false);
    expect(StandInWriterInputSchema.safeParse({ ...base, tables: [{ ...tables[0], rowsData: [{ handle: "real_person" }] }] }).success).toBe(false);
    const column = (tables[0]!["columns"] as Array<Record<string, unknown>>)[1]!;
    expect(StandInWriterInputSchema.safeParse({ ...base, tables: [{ ...tables[0], columns: [{ ...column, sample: "jane@real.example" }] }] }).success).toBe(false);
  });
  it("never lets a key be written, and refuses a table with nothing to write, nothing at all, and poisonous names", () => {
    const base = JSON.parse(JSON.stringify(input())) as { tables: Array<{ columns: Array<Record<string, unknown>> }> };
    expect(StandInWriterInputSchema.safeParse({ tables: [{ name: "t", rows: 1, columns: [{ name: "id", kind: "integer", key: true, writable: true }] }], operations: [] }).success).toBe(false);
    expect(StandInWriterInputSchema.safeParse({ tables: [{ name: "t", rows: 1, columns: [{ name: "id", kind: "integer", key: true, writable: false }] }], operations: [] }).success).toBe(false);
    expect(StandInWriterInputSchema.safeParse({ tables: [], operations: [] }).success).toBe(false);
    for (const name of ["__proto__", "constructor", "prototype", "toString"]) {
      expect(StandInWriterInputSchema.safeParse({ tables: [{ ...base.tables[0], name }], operations: [] }).success).toBe(false);
    }
  });
  it("bounds rows, columns, tables and the request's own bytes", () => {
    const column = (name: string) => ({ name, kind: "text", key: false, writable: true });
    expect(StandInWriterInputSchema.safeParse({ tables: [{ name: "t", rows: STANDIN_LIMITS.rowsPerTable + 1, columns: [column("a")] }], operations: [] }).success).toBe(false);
    expect(StandInWriterInputSchema.safeParse({ tables: [{ name: "t", rows: 1, columns: Array.from({ length: STANDIN_LIMITS.columnsPerTable + 1 }, (_, i) => column(`c${String(i)}`)) }], operations: [] }).success).toBe(false);
    const wide = Array.from({ length: STANDIN_LIMITS.tables }, (_, t) => ({ name: `table_${String(t)}`, rows: 50, columns: Array.from({ length: 30 }, (_, i) => ({ ...column(`column_with_a_long_name_${String(i)}`), oneOf: Array.from({ length: 20 }, (_, v) => `value number ${String(v)} of the list`) })) }));
    expect(StandInWriterInputSchema.safeParse({ tables: wide, operations: [] }).success).toBe(false);
  });
});

describe("the reply fits the request, whole, or is refused with one fixed word", () => {
  it("reads a good reply, keys sorted, and pins the request it was written for", () => {
    const read = parse(goodReply);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.set.requestDigest).toBe(standInRequestDigest(input()));
      expect(Object.keys(read.set.tables["creators"]![0]!)).toEqual(["bio", "followers", "handle", "joined_at", "tier"]);
      expect(StandInWriterSetSchema.safeParse(read.set).success).toBe(true);
    }
  });
  it("gives the same set, byte for byte, whatever the order of the model's keys and spaces (deterministic per version)", () => {
    const a = parse(JSON.stringify(goodReply));
    const shuffled = { answers: goodReply.answers, tables: { creators: goodReply.tables.creators.map((row) => Object.fromEntries(Object.entries(row).reverse())) } };
    const b = parse(JSON.stringify(shuffled, null, 4));
    expect(a.ok && b.ok && standInSetDigest(a.set) === standInSetDigest(b.set)).toBe(true);
    const fenced = parse("```json\n" + JSON.stringify(goodReply) + "\n```");
    expect(fenced.ok && a.ok && standInSetDigest(fenced.set) === standInSetDigest(a.set)).toBe(true);
  });
  it("refuses a table, a column or an operation the request did not name, and a key column", () => {
    expect(parse({ tables: { users: [{ name: "x" }] } })).toEqual({ ok: false, reason: "not_requested" });
    expect(parse({ tables: { creators: [{ handle: "a", password: "x" }] } })).toEqual({ ok: false, reason: "not_requested" });
    expect(parse({ tables: { creators: [{ id: 7, handle: "a" }] } })).toEqual({ ok: false, reason: "not_requested" });
    expect(parse({ answers: { elsewhere: [{ a: 1 }] } })).toEqual({ ok: false, reason: "not_requested" });
    expect(parse({ ...goodReply, extra: 1 })).toEqual({ ok: false, reason: "not_requested" });
    expect(parse('{"tables":{"__proto__":[{"handle":"a"}]}}')).toEqual({ ok: false, reason: "not_requested" });
  });
  it("refuses a value of the wrong kind, too long, out of the allowed list, a bad time or hidden characters", () => {
    const row = (over: Record<string, unknown>) => ({ tables: { creators: [{ handle: "a", ...over }] } });
    expect(parse(row({ followers: "many" }))).toEqual({ ok: false, reason: "wrong_type" });
    expect(parse(row({ followers: 1.5 }))).toEqual({ ok: false, reason: "wrong_type" });
    expect(parse(row({ handle: "x".repeat(31) }))).toEqual({ ok: false, reason: "wrong_type" });
    expect(parse(row({ tier: "mega" }))).toEqual({ ok: false, reason: "wrong_type" });
    expect(parse(row({ joined_at: "yesterday" }))).toEqual({ ok: false, reason: "wrong_type" });
    expect(parse(row({ bio: "line\u0000break" }))).toEqual({ ok: false, reason: "wrong_type" });
    expect(parse(row({ bio: null }))).toEqual({ ok: false, reason: "wrong_type" });
    expect(parse({ tables: { creators: [{}] } })).toEqual({ ok: false, reason: "wrong_type" });
  });
  it("refuses more rows or answers than asked, an answer that misses a required field or has a field of the wrong kind", () => {
    expect(parse({ tables: { creators: Array.from({ length: 4 }, (_, i) => ({ handle: `h${String(i)}` })) } })).toEqual({ ok: false, reason: "too_many" });
    expect(parse({ answers: { "tiktok-user": [goodReply.answers["tiktok-user"][0], goodReply.answers["tiktok-user"][1], goodReply.answers["tiktok-user"][0]] } })).toEqual({ ok: false, reason: "too_many" });
    expect(parse({ answers: { "tiktok-user": [{ data: { user: { display_name: "A" } } }] } })).toEqual({ ok: false, reason: "wrong_type" });
    expect(parse({ answers: { "tiktok-user": [{ data: { user: { display_name: "A", follower_count: "12" } } }] } })).toEqual({ ok: false, reason: "wrong_type" });
    expect(parse({ answers: { "tiktok-user": [{ data: { user: { display_name: "A", follower_count: 1, videos: [{ title: "ok" }, { title: 3 }] } } }] } })).toEqual({ ok: false, reason: "wrong_type" });
    expect(parse({ answers: { "tiktok-user": ["text"] } })).toEqual({ ok: false, reason: "wrong_type" });
  });
  it("refuses a reply that is not one JSON object, one that writes nothing, one over the bytes cap, and a request that is not valid", () => {
    expect(parse("here is your data: {}")).toEqual({ ok: false, reason: "unreadable" });
    expect(parse("[1,2]")).toEqual({ ok: false, reason: "unreadable" });
    expect(parse({ tables: { creators: [] }, answers: {} })).toEqual({ ok: false, reason: "nothing_written" });
    expect(parse("{}")).toEqual({ ok: false, reason: "nothing_written" });
    expect(parse(" ".repeat(STANDIN_LIMITS.setBytes * 2 + 1))).toEqual({ ok: false, reason: "too_large" });
    const big = input({ tables: [{ name: "t", rows: 50, columns: [{ name: "c", kind: "text", key: false, writable: true, maxChars: 400 }] }], operations: [] });
    const rows = Array.from({ length: 50 }, (_, i) => ({ c: `${"é".repeat(399)}${String(i % 10)}` }));
    expect(parseStandInWriterOutput(JSON.stringify({ tables: { t: rows } }), big)).toEqual({ ok: false, reason: "too_large" });
    expect(parseStandInWriterOutput("{}", { tables: [], operations: [] })).toEqual({ ok: false, reason: "not_for_this_request" });
  });
  it("reads an enormous reply in bounded time (no pattern times item loop)", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ handle: `h${String(i)}`, bio: "b".repeat(150) }));
    const started = Date.now();
    for (let i = 0; i < 50; i += 1) parse({ tables: { creators: rows } }, input({ tables: [{ ...input().tables[0]!, rows: 50 }] }));
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("the stored form is read strictly and pinned by a digest", () => {
  it("round-trips, and refuses a set that is not the writer's, holds nothing, or has an odd shape", () => {
    const read = parse(goodReply);
    if (!read.ok) throw new Error("fixture");
    expect(StandInWriterSetSchema.safeParse(JSON.parse(JSON.stringify(read.set))).success).toBe(true);
    expect(StandInWriterSetSchema.safeParse({ ...read.set, writer: "someone-else" }).success).toBe(false);
    expect(StandInWriterSetSchema.safeParse({ ...read.set, tables: {}, answers: {} }).success).toBe(false);
    expect(StandInWriterSetSchema.safeParse({ ...read.set, extra: true }).success).toBe(false);
    expect(StandInWriterSetSchema.safeParse({ ...read.set, tables: { "__proto__": [{ a: "x" }] } }).success).toBe(false);
    expect(StandInWriterSetSchema.safeParse({ ...read.set, requestDigest: "nope" }).success).toBe(false);
  });
  it("a new set is a new version part for the eval's stand-in version; no set is the word none (E4)", () => {
    const a = parse(goodReply); const b = parse({ ...goodReply, tables: { creators: [goodReply.tables.creators[0]] } });
    if (!a.ok || !b.ok) throw new Error("fixture");
    expect(standInVersionPart(undefined)).toBe("none");
    expect(standInVersionPart(a.set)).toMatch(/^[a-f0-9]{64}$/u);
    expect(standInVersionPart(a.set)).toBe(standInVersionPart(a.set));
    expect(standInVersionPart(a.set)).not.toBe(standInVersionPart(b.set));
  });
});

describe("one request gets one example, the same every run", () => {
  it("hashes the key: the same key and count give the same index; keys spread over the examples; a count under 2 is 0", () => {
    expect(pickStandInIndex("tiktok:mara_codes", 10)).toBe(pickStandInIndex("tiktok:mara_codes", 10));
    const seen = new Set(Array.from({ length: 200 }, (_, i) => pickStandInIndex(`user-${String(i)}`, 10)));
    expect(seen.size).toBe(10);
    expect(pickStandInIndex("x", 1)).toBe(0);
    expect(pickStandInIndex("x", 0)).toBe(0);
    expect(pickStandInIndex("x", Number.NaN)).toBe(0);
    for (let i = 0; i < 100; i += 1) expect(pickStandInIndex(`k${String(i)}`, 7)).toBeLessThan(7);
  });
});

describe("building the request from the two readers (E3 tables, E6 answer shapes)", () => {
  const seamTable = (name: string, over: Record<string, unknown> = {}) => ({ name, rows: 20, columns: [{ name: "id", kind: "integer" as const, key: true }, { name: "bio", kind: "text" as const, key: false, maxChars: 120 }], ...over });
  it("keeps keys unwritable, caps the rows, and leaves a table that cannot be described out whole", () => {
    const built = buildStandInRequest([seamTable("b_posts", { rows: 500 }), seamTable("a_users"), seamTable("only_keys", { columns: [{ name: "id", kind: "integer" as const, key: true }] }), seamTable("bad name!")], []);
    expect(built?.input.tables.map((table) => table.name)).toEqual(["a_users", "b_posts"]);
    expect(built?.input.tables[1]!.rows).toBe(STANDIN_LIMITS.rowsPerTable);
    expect(built?.input.tables[0]!.columns.map((column) => [column.name, column.writable])).toEqual([["id", false], ["bio", true]]);
    expect(built?.leftOut.sort()).toEqual(["bad name!", "only_keys"]);
  });
  it("copies nothing but names, kinds and limits: a value smuggled into the seam does not reach the request", () => {
    const smuggled = { ...seamTable("users"), columns: [{ name: "email", kind: "text" as const, key: false, sample: "jane.doe@gmail.com", default: "secret-value-12345" }] };
    const built = buildStandInRequest([smuggled], []);
    expect(JSON.stringify(built)).not.toContain("jane.doe");
    expect(JSON.stringify(built)).not.toContain("secret-value");
  });
  it("turns an answer shape into plain fields, and leaves out one it cannot read", () => {
    const shape = { type: "object" as const, fields: [{ name: "data", required: true, shape: { type: "object" as const, fields: [{ name: "users", required: false, shape: { type: "array" as const, items: { type: "object" as const, fields: [{ name: "bio", required: true, shape: { type: "string" as const } }, { name: "gone", required: false, shape: { type: "null" as const } }] } } }] } }] };
    expect(standInFieldsOf(shape)).toEqual([{ path: "data.users[].bio", kind: "string", required: false }]);
    expect(standInFieldsOf({ type: "string" })).toBeUndefined();
    expect(standInFieldsOf({ type: "object", fields: [{ name: "bad name", required: true, shape: { type: "string" } }] })).toBeUndefined();
    expect(standInFieldsOf({ type: "object", fields: [{ name: "__proto__", required: true, shape: { type: "string" } }] })).toBeUndefined();
    const built = buildStandInRequest([], [{ id: "get-users", host: "api.example.test", method: "GET", path: "/users", shape }, { id: "odd", host: "api.example.test", method: "GET", path: "/odd", shape: { type: "string" } }]);
    expect(built?.input.operations.map((operation) => operation.id)).toEqual(["get-users"]);
    expect(built?.leftOut).toEqual(["odd"]);
    expect(buildStandInRequest([], [])).toBeUndefined();
  });
  it("drops whole tables from the end, never a half, when the request is too large to send", () => {
    const many = Array.from({ length: 20 }, (_, t) => ({ name: `t${String(t).padStart(2, "0")}`, rows: 50, columns: Array.from({ length: 30 }, (_, i) => ({ name: `column_with_a_long_name_${String(i)}`, kind: "text" as const, key: false, oneOf: Array.from({ length: 20 }, (_, v) => `value number ${String(v)} of the list`) })) }));
    const built = buildStandInRequest(many, []);
    expect(built).toBeDefined();
    expect(built!.leftOut.length).toBeGreaterThan(0);
    expect(built!.input.tables.length + built!.leftOut.length).toBe(20);
    expect(built!.input.tables.every((table) => table.columns.length === 30)).toBe(true);
  });
});

describe("the cost is known before the run, and the writer is paid from the run's cap", () => {
  const price = { inputPerMTok: 3, outputPerMTok: 15 };
  it("has a ceiling that no request can pass, and an estimate below it", () => {
    const ceiling = standInWriterCeilingCents(price);
    expect(ceiling).toBeGreaterThan(0);
    expect(standInWriterEstimateCents(input(), price)).toBeLessThanOrEqual(ceiling);
    const biggest = StandInWriterInputSchema.parse({ tables: Array.from({ length: 6 }, (_, t) => ({ name: `t${String(t)}`, rows: 50, columns: Array.from({ length: 20 }, (_, i) => ({ name: `c${String(i)}`, kind: "text", key: false, writable: true, maxChars: 400 })) })), operations: [] });
    expect(standInWriterEstimateCents(biggest, price)).toBeLessThanOrEqual(ceiling);
    // The ceiling is what the longest request plus the output cap cost, so it rises with either price.
    expect(standInWriterCeilingCents({ inputPerMTok: 6, outputPerMTok: 15 })).toBeGreaterThan(ceiling);
    expect(standInWriterCeilingCents({ inputPerMTok: 3, outputPerMTok: 30 })).toBeGreaterThan(ceiling);
    expect(standInWriterCeilingCents({ inputPerMTok: Number.NaN, outputPerMTok: 1 })).toBe(Number.POSITIVE_INFINITY);
  });
  it("uses the price of the model Rovara recommends when the card does not know the run's model (say \"about\"), and the real price when it does (say \"up to\")", () => {
    const reference = standInReferencePrice();
    expect(reference.inputPerMTok).toBeGreaterThan(0);
    expect(reference.outputPerMTok).toBeGreaterThan(0);
    // Not the dearest model in the catalog: that would say "no room" on every default setup.
    expect(standInWriterCeilingCents(reference)).toBeLessThan(400);
    expect(standInWriterCard({ connected: true, capCents: 400 }).words).toContain(" about $");
    expect(standInWriterCard({ connected: true, capCents: 400, price }).words).toContain(" up to $");
    expect(standInWriterCard({ connected: true, capCents: 400, price }).ceilingCents).toBe(standInWriterCeilingCents(price));
  });
  it("shows the cost first, inside the run's limit, in the setup cap's own format; says so when no AI is connected or the limit has no room", () => {
    const card = standInWriterCard({ connected: true, capCents: 400, price });
    expect(card.connected).toBe(true);
    expect(card.words).toBe(STANDIN_WRITER_WORDS.card(card.ceilingCents!, 400));
    expect(card.words).toMatch(/up to \$\d+(\.\d\d)?, inside this run's \$4 limit/u);
    expect(card.words).toContain("never sees a change");
    expect(card.words).toContain("never copies a row from your real database");
    expect(standInWriterCard({ connected: false, capCents: 400 })).toEqual({ connected: false, words: STANDIN_WRITER_WORDS.noAi });
    expect(STANDIN_WRITER_WORDS.noAi).toContain("Connect your AI first");
    expect(STANDIN_WRITER_WORDS.noAi).toContain("never pays");
    expect(standInWriterCard({ connected: true, capCents: 5, price })).toEqual({ connected: true, words: STANDIN_WRITER_WORDS.cardNoRoom });
  });
});
