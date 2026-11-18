// L4-E7 (setup-and-evals final review, decision N4/N5): the STAND-IN WRITER. During a setup run Rovara asks the COMPANY's own AI (the customer pays, never Rovara) to write realistic sample data that fits the project's
// database tables and the outside services' answer shapes ("50 influencer profiles", not the word "example"), once, inside the setup run's spending limit, with the cost shown first. This file holds only the shapes
// and the pure rules, so the worker (prompt, run), the broker (store, card words) and the eval lanes (E3 rows, E5/E6 answers, E4 version digest) read one definition.
//
// What the shapes guarantee, so no builder has to remember it:
//   - THE INPUT IS A SHAPE, NEVER DATA (N5): table and column names and kinds, the answer shapes of an outside operation. There is no field that could carry a row, a diff or a task: a request that holds one is refused
//     (`.strict()`), so the writer's prompt cannot hold a change or a row copied from a real database.
//   - THE OUTPUT FITS THE INPUT OR IT IS REFUSED, whole: only tables, columns (writable ones: never a key) and operations the input named, only as many rows and answers as asked, every value of the column's kind, within
//     the bytes cap. Nothing is cut or guessed; a partly wrong answer is a refusal (`parseStandInWriterOutput`).
//   - BOUNDED: tables, columns, rows, operations, answers, bytes and tokens all have a maximum, so the writer's cost has a CEILING that is known before the run (`standInWriterCeilingCents`), and the run reserves it from its cap.
//   - VERSIONED BY DIGEST: a stored set is pinned by `standInSetDigest` (the canonical JSON of the set). A later setup run that writes a different set is a new version; E4 puts the digest in the stand-in version it hashes
//     into the eval's base-cache key, so a new version re-runs the baseline.
//   - THE SAME FOR EVERY RUN: a request chooses one stored example by hashing its own key (`pickStandInIndex`), so the same request gets the same example on both sides of a comparison, every run.
// Pure: no network, no store, no clock. Browser-safe except for the hash (`web-hash`).
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { E2E_AGENT_ELIGIBLE_MODELS, E2E_AGENT_RECOMMENDED_MODELS } from "./e2e-agent-models.js";
import { sha256Hex } from "./web-hash.js";

/** The writer's name, kept on every set it writes. */
export const STANDIN_WRITER_VERSION = "rovara-standin-writer/1" as const;
export const STANDIN_SET_SCHEMA_VERSION = 1 as const;

export const STANDIN_LIMITS = {
  tables: 20, columnsPerTable: 30, rowsPerTable: 50, enumValues: 20, operations: 20, fieldsPerOperation: 60, answersPerOperation: 20,
  /** Characters of one text cell (a column may ask for fewer). */
  cellChars: 400,
  /** Bytes of one answer's JSON. */
  answerBytes: 4_096,
  /** Bytes of ALL the writer wrote (cells and answers, canonical JSON): the size of a stored set. */
  setBytes: 32 * 1_024,
  /** Bytes of the request the model reads (the shapes, as JSON). */
  inputBytes: 24 * 1_024,
  /** The most the model may write in one reply, in tokens: the output cap its session is opened with. */
  outputTokens: 10_000,
} as const;

/** One token is at least this many bytes of the JSON the writer reads and writes; two is below what real tokenizers do for JSON, so a bound made with it is never too low. */
const BYTES_PER_TOKEN = 2;
/** The words the writer is told, in bytes (a fixed text): part of the input side of the ceiling. */
export const STANDIN_PROMPT_FIXED_BYTES = 3_072;
/** A cache write costs 1.25 times the input price (the setup run counts it so): the ceiling prices the input at that. */
const INPUT_PRICE_FACTOR = 1.25;

// ---- names

const NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/u;
const POISON: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty"]);
const nameOf = z.string().regex(NAME, "a plain name").refine((name) => !POISON.has(name), "a plain name");
const OPERATION_ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const HOST = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const FIELD_PATH = /^[A-Za-z0-9_$.[\]-]{1,120}$/u;
const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

// ---- the request: shapes only

export const STANDIN_COLUMN_KINDS = ["text", "integer", "number", "boolean", "timestamp"] as const;
export type StandInColumnKind = (typeof STANDIN_COLUMN_KINDS)[number];

const ColumnSchema = z.object({
  name: nameOf,
  kind: z.enum(STANDIN_COLUMN_KINDS),
  /** A primary or foreign key (or anything else Rovara's own generator fills): the writer never writes it, so keys always respect foreign keys. */
  key: z.boolean(),
  /** True for a column the writer fills. A key is never writable. */
  writable: z.boolean(),
  /** A text column's longest value (at most `STANDIN_LIMITS.cellChars`). */
  maxChars: z.number().int().min(1).max(STANDIN_LIMITS.cellChars).optional(),
  /** The only values a column accepts (a check constraint or an enum type). */
  oneOf: z.array(z.string().min(1).max(60).regex(NO_HIDDEN)).min(1).max(STANDIN_LIMITS.enumValues).optional(),
}).strict().refine((column) => !(column.key && column.writable), { message: "a key is never written by the writer", path: ["writable"] });

const TableSchema = z.object({
  name: nameOf,
  columns: z.array(ColumnSchema).min(1).max(STANDIN_LIMITS.columnsPerTable),
  /** How many rows are wanted (the generator's count for the table). */
  rows: z.number().int().min(1).max(STANDIN_LIMITS.rowsPerTable),
}).strict().superRefine((table, context) => {
  if (new Set(table.columns.map((column) => column.name)).size !== table.columns.length) context.addIssue({ code: "custom", path: ["columns"], message: "a column is listed once" });
  if (!table.columns.some((column) => column.writable)) context.addIssue({ code: "custom", path: ["columns"], message: "a table with nothing to write is not sent" });
});

export const STANDIN_FIELD_KINDS = ["string", "number", "integer", "boolean"] as const;
const FieldSchema = z.object({
  /** Where the value is in the answer: dotted names, `[]` for each element of a list (`data.users[].bio`). */
  path: z.string().regex(FIELD_PATH),
  kind: z.enum(STANDIN_FIELD_KINDS),
  required: z.boolean(),
}).strict();

const OperationSchema = z.object({
  id: z.string().regex(OPERATION_ID),
  host: z.string().regex(HOST),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().regex(/^\/[A-Za-z0-9._~%:@!$&'()*+,;=/{}-]{0,200}$/u),
  fields: z.array(FieldSchema).min(1).max(STANDIN_LIMITS.fieldsPerOperation),
  /** How many different answers are wanted (a pool a request picks from by hashing its key). */
  answers: z.number().int().min(1).max(STANDIN_LIMITS.answersPerOperation),
}).strict().refine((operation) => new Set(operation.fields.map((field) => field.path)).size === operation.fields.length, { message: "a field is listed once", path: ["fields"] });

/** What the writer is asked for. Shapes only: nothing here is a row, a task, a change or a secret. */
export const StandInWriterInputSchema = z.object({
  tables: z.array(TableSchema).max(STANDIN_LIMITS.tables),
  operations: z.array(OperationSchema).max(STANDIN_LIMITS.operations),
}).strict().superRefine((input, context) => {
  if (input.tables.length + input.operations.length === 0) context.addIssue({ code: "custom", path: [], message: "there is nothing to write" });
  if (new Set(input.tables.map((table) => table.name)).size !== input.tables.length) context.addIssue({ code: "custom", path: ["tables"], message: "a table is listed once" });
  if (new Set(input.operations.map((operation) => operation.id)).size !== input.operations.length) context.addIssue({ code: "custom", path: ["operations"], message: "an operation is listed once" });
  if (new TextEncoder().encode(canonicalJson(input)).length > STANDIN_LIMITS.inputBytes) context.addIssue({ code: "custom", path: [], message: "the request is too large" });
});
export type StandInWriterInput = z.infer<typeof StandInWriterInputSchema>;

// ---- the answer shape of an outside operation, from the contract finder (E6)

/** The part of an answer shape the writer needs (a structural subset of `AnswerShape` of service-contract.ts, so no import cycle and no provenance). */
export type StandInShape =
  | { type: "object"; fields: ReadonlyArray<{ name: string; required: boolean; shape: StandInShape }> }
  | { type: "array"; items: StandInShape }
  | { type: "number" | "integer" | "string" | "boolean" | "null" };

/**
 * The leaf fields of an answer shape, in a fixed order, as the writer's `fields`. A name that is not a plain path part, a shape nested deeper than 8 levels, or more than the field limit, gives `undefined`: the operation is
 * left out (never half described). A `null` leaf is skipped (nothing to write).
 */
export function standInFieldsOf(shape: StandInShape): StandInWriterInput["operations"][number]["fields"] | undefined {
  const out: Array<{ path: string; kind: (typeof STANDIN_FIELD_KINDS)[number]; required: boolean }> = [];
  let refused = false;
  const walk = (node: StandInShape, path: string, required: boolean, depth: number): void => {
    if (refused) return;
    if (depth > 8 || out.length > STANDIN_LIMITS.fieldsPerOperation) { refused = true; return; }
    if (node.type === "object") {
      for (const field of node.fields) {
        if (!/^[A-Za-z0-9_$-]{1,60}$/u.test(field.name) || POISON.has(field.name)) { refused = true; return; }
        walk(field.shape, path === "" ? field.name : `${path}.${field.name}`, required && field.required, depth + 1);
      }
    } else if (node.type === "array") walk(node.items, `${path}[]`, required, depth + 1);
    else if (node.type !== "null") { if (path === "") refused = true; else out.push({ path, kind: node.type === "number" ? "number" : node.type === "integer" ? "integer" : node.type, required }); }
  };
  walk(shape, "", true, 0);
  return refused || out.length === 0 || out.length > STANDIN_LIMITS.fieldsPerOperation ? undefined : out;
}

// ---- building the request from the two readers (E3: tables from the schema reading; E6: answer shapes from the contract finder)

/** One table as the schema reading (E3) describes it: names and kinds, never a value. */
export interface StandInTableSeam {
  name: string;
  columns: ReadonlyArray<{ name: string; kind: StandInColumnKind; key: boolean; maxChars?: number | undefined; oneOf?: readonly string[] | undefined }>;
  /** The rows the generator makes for this table. */
  rows: number;
}
/** One outside operation as the contract finder (E6) describes it. */
export interface StandInOperationSeam { id: string; host: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; shape: StandInShape; answers?: number | undefined }

/** How many examples of one outside operation the writer is asked for when the seam names none. */
export const STANDIN_DEFAULT_ANSWERS = 10;

/**
 * The writer's request from what the two readers found, and what was left out. Tables are taken in name order and a table is whole or left out (more columns than the limit, nothing to write, a name the request refuses):
 * the generator fills what the writer does not, so a table left out is never half described. The rows asked for are the table's own count, at most the row limit. A key column is never writable. Operations whose shape
 * cannot be read as plain fields are left out the same way. Undefined when nothing is left to write. Pure.
 */
export function buildStandInRequest(tables: readonly StandInTableSeam[], operations: readonly StandInOperationSeam[]): { input: StandInWriterInput; leftOut: string[] } | undefined {
  const leftOut: string[] = [];
  const keptTables: StandInWriterInput["tables"] = [];
  for (const table of [...tables].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const candidate = {
      name: table.name,
      rows: Math.min(STANDIN_LIMITS.rowsPerTable, Math.max(1, Math.trunc(table.rows))),
      columns: table.columns.map((column) => ({
        name: column.name, kind: column.kind, key: column.key, writable: !column.key,
        ...(column.kind === "text" && column.maxChars !== undefined ? { maxChars: Math.min(STANDIN_LIMITS.cellChars, Math.max(1, Math.trunc(column.maxChars))) } : {}),
        ...(column.oneOf === undefined || column.oneOf.length === 0 ? {} : { oneOf: [...column.oneOf] }),
      })),
    };
    const checked = TableSchema.safeParse(candidate);
    if (!checked.success || keptTables.length >= STANDIN_LIMITS.tables) { leftOut.push(table.name); continue; }
    keptTables.push(checked.data);
  }
  const keptOperations: StandInWriterInput["operations"] = [];
  for (const operation of [...operations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const fields = standInFieldsOf(operation.shape);
    const checked = fields === undefined ? undefined : OperationSchema.safeParse({ id: operation.id, host: operation.host, method: operation.method, path: operation.path, fields, answers: Math.min(STANDIN_LIMITS.answersPerOperation, Math.max(1, Math.trunc(operation.answers ?? STANDIN_DEFAULT_ANSWERS))) });
    if (checked === undefined || !checked.success || keptOperations.length >= STANDIN_LIMITS.operations) { leftOut.push(operation.id); continue; }
    keptOperations.push(checked.data);
  }
  // Too large to send: the last operation, then the last table, go (whole), until it fits.
  for (;;) {
    if (keptTables.length + keptOperations.length === 0) return undefined;
    const built = StandInWriterInputSchema.safeParse({ tables: keptTables, operations: keptOperations });
    if (built.success) return { input: built.data, leftOut };
    const dropped = keptOperations.length > 0 ? keptOperations.pop()!.id : keptTables.pop()!.name;
    leftOut.push(dropped);
  }
}

// ---- the output: written values

export type StandInCell = string | number | boolean;
/** What the writer wrote, in the shape of the request. Rows are in order: row 0 of a table is the example E3's generator puts in its row 0. */
export interface StandInWriterSet {
  schemaVersion: typeof STANDIN_SET_SCHEMA_VERSION;
  writer: typeof STANDIN_WRITER_VERSION;
  /** The SHA-256 of the request (its canonical JSON) this set was written for, so a set is never used for another shape without notice. */
  requestDigest: string;
  tables: Record<string, Array<Record<string, StandInCell>>>;
  /** Per operation id, the answers (each a JSON value); a request picks one by hashing its key. */
  answers: Record<string, unknown[]>;
}

export const standInRequestDigest = (input: StandInWriterInput): string => sha256Hex(`rovara-standin-request/v1\n${canonicalJson(input)}`);

/** The digest a stored set is pinned by: the canonical JSON of the set under a fixed domain. E4 puts this in the stand-in version. */
export function standInSetDigest(set: StandInWriterSet): string {
  return sha256Hex(`rovara-standin-set/v1\n${canonicalJson(set)}`);
}

/**
 * The part the eval's stand-in version holds for the writer (E4): the set's digest, or the word `none` when there is no set. Added to the version's other parts (images, seeds, generator version, answer sets), so a new
 * set, or the loss of the old one, is a new version and the baseline is measured again inside the cap.
 */
export const standInVersionPart = (set: StandInWriterSet | undefined): string => (set === undefined ? "none" : standInSetDigest(set));

export const STANDIN_REFUSALS = ["unreadable", "too_large", "not_requested", "wrong_type", "too_many", "nothing_written", "not_for_this_request"] as const;
export type StandInRefusal = (typeof STANDIN_REFUSALS)[number];
export type StandInParse = { ok: true; set: StandInWriterSet } | { ok: false; reason: StandInRefusal };

const own = (object: object, key: string): boolean => Object.hasOwn(object, key);
const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The model's reply as a JSON value: one object, optionally in one code fence; anything else is unreadable. */
export function standInJsonOf(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(trimmed);
  return JSON.parse(fenced === null ? trimmed : fenced[1]!) as unknown;
}

function cellOf(column: z.infer<typeof ColumnSchema>, value: unknown): StandInCell | undefined {
  switch (column.kind) {
    case "text": {
      if (typeof value !== "string" || value.length === 0 || [...value].length > (column.maxChars ?? STANDIN_LIMITS.cellChars) || !NO_HIDDEN.test(value)) return undefined;
      return column.oneOf !== undefined && !column.oneOf.includes(value) ? undefined : value;
    }
    case "integer": return typeof value === "number" && Number.isSafeInteger(value) && (column.oneOf === undefined || column.oneOf.includes(String(value))) ? value : undefined;
    case "number": return typeof value === "number" && Number.isFinite(value) && (column.oneOf === undefined || column.oneOf.includes(String(value))) ? value : undefined;
    case "boolean": return typeof value === "boolean" ? value : undefined;
    case "timestamp": return typeof value === "string" && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined;
  }
}

/** Walks `path` (`a.b[].c`) through a JSON value and returns every value found there; `undefined` entries stand for a path that leads nowhere. */
function valuesAt(value: unknown, path: string): unknown[] {
  let nodes: unknown[] = [value];
  for (const part of path.split(".")) {
    const lists = (part.match(/\[\]/gu) ?? []).length;
    const name = part.replace(/\[\]/gu, "");
    nodes = nodes.map((node) => (name === "" ? node : isPlainObject(node) && own(node, name) ? node[name] : undefined));
    for (let level = 0; level < lists; level += 1) nodes = nodes.flatMap((node) => (Array.isArray(node) ? (node as unknown[]) : [undefined]));
  }
  return nodes;
}

const kindFits = (kind: (typeof STANDIN_FIELD_KINDS)[number], value: unknown): boolean =>
  kind === "string" ? typeof value === "string" && value.length > 0 && NO_HIDDEN.test(value) : kind === "boolean" ? typeof value === "boolean" : kind === "integer" ? typeof value === "number" && Number.isSafeInteger(value) : typeof value === "number" && Number.isFinite(value);

function answerFits(operation: StandInWriterInput["operations"][number], answer: unknown): boolean {
  if (answer === null || typeof answer !== "object") return false;
  if (new TextEncoder().encode(canonicalJson(answer)).length > STANDIN_LIMITS.answerBytes) return false;
  for (const field of operation.fields) {
    const found = valuesAt(answer, field.path);
    // A required field must be there at least once and every value found must be of its kind; an optional field may be missing.
    if (found.some((value) => value !== undefined && !kindFits(field.kind, value))) return false;
    if (field.required && !found.some((value) => value !== undefined)) return false;
    if (field.required && found.some((value) => value === undefined)) return false;
  }
  return true;
}

/**
 * Reads the model's reply against the request it was written for. Whole or refused, with one fixed word and never the model's text:
 *   unreadable: not one JSON object; too_large: over the bytes cap; not_requested: a table, column, operation or key the request did not name (or a key column); wrong_type: a value that is not of its column's or field's kind;
 *   too_many: more rows or answers than asked; nothing_written: no table and no answer at all.
 */
export function parseStandInWriterOutput(text: string, rawInput: unknown): StandInParse {
  const request = StandInWriterInputSchema.safeParse(rawInput);
  if (!request.success) return { ok: false, reason: "not_for_this_request" };
  const input = request.data;
  if (typeof text !== "string" || new TextEncoder().encode(text).length > STANDIN_LIMITS.setBytes * 2) return { ok: false, reason: "too_large" };
  let parsed: unknown;
  try { parsed = standInJsonOf(text); } catch { return { ok: false, reason: "unreadable" }; }
  if (!isPlainObject(parsed)) return { ok: false, reason: "unreadable" };
  if (Object.keys(parsed).some((key) => key !== "tables" && key !== "answers")) return { ok: false, reason: "not_requested" };
  const tablesIn = parsed["tables"] ?? {};
  const answersIn = parsed["answers"] ?? {};
  if (!isPlainObject(tablesIn) || !isPlainObject(answersIn)) return { ok: false, reason: "unreadable" };
  const tables: StandInWriterSet["tables"] = {};
  for (const name of Object.keys(tablesIn).sort()) {
    const table = input.tables.find((candidate) => candidate.name === name);
    if (table === undefined) return { ok: false, reason: "not_requested" };
    const rowsIn = tablesIn[name];
    if (!Array.isArray(rowsIn)) return { ok: false, reason: "unreadable" };
    if (rowsIn.length > table.rows) return { ok: false, reason: "too_many" };
    const rows: Array<Record<string, StandInCell>> = [];
    for (const rowIn of rowsIn as unknown[]) {
      if (!isPlainObject(rowIn)) return { ok: false, reason: "unreadable" };
      const row: Record<string, StandInCell> = {};
      for (const columnName of Object.keys(rowIn).sort()) {
        const column = table.columns.find((candidate) => candidate.name === columnName);
        if (column === undefined || !column.writable) return { ok: false, reason: "not_requested" };
        const cell = cellOf(column, rowIn[columnName]);
        if (cell === undefined) return { ok: false, reason: "wrong_type" };
        row[columnName] = cell;
      }
      if (Object.keys(row).length === 0) return { ok: false, reason: "wrong_type" };
      rows.push(row);
    }
    if (rows.length > 0) tables[name] = rows;
  }
  const answers: StandInWriterSet["answers"] = {};
  for (const id of Object.keys(answersIn).sort()) {
    const operation = input.operations.find((candidate) => candidate.id === id);
    if (operation === undefined) return { ok: false, reason: "not_requested" };
    const list = answersIn[id];
    if (!Array.isArray(list)) return { ok: false, reason: "unreadable" };
    if (list.length > operation.answers) return { ok: false, reason: "too_many" };
    if (!(list as unknown[]).every((answer) => answerFits(operation, answer))) return { ok: false, reason: "wrong_type" };
    if (list.length > 0) answers[id] = (list as unknown[]).map((answer) => JSON.parse(canonicalJson(answer)) as unknown);
  }
  if (Object.keys(tables).length + Object.keys(answers).length === 0) return { ok: false, reason: "nothing_written" };
  const set: StandInWriterSet = { schemaVersion: STANDIN_SET_SCHEMA_VERSION, writer: STANDIN_WRITER_VERSION, requestDigest: standInRequestDigest(input), tables, answers };
  if (new TextEncoder().encode(canonicalJson(set)).length > STANDIN_LIMITS.setBytes) return { ok: false, reason: "too_large" };
  return { ok: true, set };
}

/** The stored form, read back: strict, bounded and with the writer's own name; used by the broker before it stores a set the worker sent and before it hands one out. */
export const StandInWriterSetSchema: z.ZodType<StandInWriterSet> = z.object({
  schemaVersion: z.literal(STANDIN_SET_SCHEMA_VERSION),
  writer: z.literal(STANDIN_WRITER_VERSION),
  requestDigest: z.string().regex(DIGEST),
  tables: z.record(nameOf, z.array(z.record(nameOf, z.union([z.string().max(STANDIN_LIMITS.cellChars * 4).regex(NO_HIDDEN), z.number().finite(), z.boolean()])).refine((row) => Object.keys(row).length >= 1 && Object.keys(row).length <= STANDIN_LIMITS.columnsPerTable)).min(1).max(STANDIN_LIMITS.rowsPerTable)).refine((tables) => Object.keys(tables).length <= STANDIN_LIMITS.tables),
  answers: z.record(z.string().regex(OPERATION_ID), z.array(z.unknown().refine((value) => value !== null && typeof value === "object" && !Array.isArray(value) && new TextEncoder().encode(canonicalJson(value)).length <= STANDIN_LIMITS.answerBytes)).min(1).max(STANDIN_LIMITS.answersPerOperation)).refine((answers) => Object.keys(answers).length <= STANDIN_LIMITS.operations),
}).strict().refine((set) => Object.keys(set.tables).length + Object.keys(set.answers).length > 0 && new TextEncoder().encode(canonicalJson(set)).length <= STANDIN_LIMITS.setBytes, { message: "a set holds something and fits its bytes" });

// ---- the same example for the same request

/**
 * Which of `count` stored examples a request gets: a hash of its key (the username asked for, the id), so one request gets one example, the same on both sides and in every run. `count` below 1 is 0.
 */
export function pickStandInIndex(key: string, count: number): number {
  if (!Number.isSafeInteger(count) || count < 2) return 0;
  const hex = sha256Hex(`rovara-standin-pick/v1\n${key}`);
  return Number.parseInt(hex.slice(0, 12), 16) % count;
}

// ---- cost: known before the run

export interface StandInModelPrice { inputPerMTok: number; outputPerMTok: number }

const centsOf = (dollars: number): number => Math.ceil(Math.round(dollars * 100 * 1_000_000) / 1_000_000);

/** The tokens of the request the model reads: the fixed words plus the shapes. */
export const standInPromptTokens = (inputBytes: number): number => Math.ceil((STANDIN_PROMPT_FIXED_BYTES + inputBytes) / BYTES_PER_TOKEN);

/**
 * The MOST one writer run can cost at a model's prices, in whole cents (rounded up): the longest request it may read plus the output cap, input priced as a cache write. It does not depend on the project, so it can be shown
 * on the setup card before any file is read, and the run reserves it from its cap: a writer whose ceiling does not fit in what is left of the cap is not started.
 */
export function standInWriterCeilingCents(price: StandInModelPrice): number {
  if (!Number.isFinite(price.inputPerMTok) || !Number.isFinite(price.outputPerMTok) || price.inputPerMTok < 0 || price.outputPerMTok < 0) return Number.POSITIVE_INFINITY;
  return centsOf((standInPromptTokens(STANDIN_LIMITS.inputBytes) * price.inputPerMTok * INPUT_PRICE_FACTOR + STANDIN_LIMITS.outputTokens * price.outputPerMTok) / 1_000_000);
}

/** The price the card uses when it does not know which model the run will use: the dearest of the models Rovara recommends on each provider (what an install uses unless an administrator chose another), else a mid-priced one. */
export function standInReferencePrice(): StandInModelPrice {
  const recommended = new Set<string>(Object.values(E2E_AGENT_RECOMMENDED_MODELS));
  let found: StandInModelPrice | undefined;
  for (const model of E2E_AGENT_ELIGIBLE_MODELS) {
    if (!recommended.has(model.modelId) || !Number.isFinite(model.inputUsdPerMTok) || !Number.isFinite(model.outputUsdPerMTok) || model.inputUsdPerMTok < 0 || model.outputUsdPerMTok < 0) continue;
    found = found === undefined ? { inputPerMTok: model.inputUsdPerMTok, outputPerMTok: model.outputUsdPerMTok } : { inputPerMTok: Math.max(found.inputPerMTok, model.inputUsdPerMTok), outputPerMTok: Math.max(found.outputPerMTok, model.outputUsdPerMTok) };
  }
  return found ?? { inputPerMTok: 3, outputPerMTok: 15 };
}

/** What this request is expected to cost (rounded up), for the run's own record; never more than the ceiling. */
export function standInWriterEstimateCents(input: StandInWriterInput, price: StandInModelPrice): number {
  const inputBytes = new TextEncoder().encode(canonicalJson(input)).length;
  const cells = input.tables.reduce((sum, table) => sum + table.rows * table.columns.filter((column) => column.writable).reduce((chars, column) => chars + Math.min(column.maxChars ?? 60, 120) + 8, 0), 0);
  const answers = input.operations.reduce((sum, operation) => sum + operation.answers * Math.min(STANDIN_LIMITS.answerBytes, 40 + operation.fields.length * 60), 0);
  const outputTokens = Math.min(STANDIN_LIMITS.outputTokens, Math.ceil((cells + answers) / BYTES_PER_TOKEN));
  const dollars = (standInPromptTokens(inputBytes) * price.inputPerMTok * INPUT_PRICE_FACTOR + outputTokens * price.outputPerMTok) / 1_000_000;
  return Math.min(centsOf(dollars), standInWriterCeilingCents(price));
}

// ---- words

/** "$4" for 400 cents, "$0.57" for 57 (the setup cap's own format). */
export const standInDollars = (cents: number): string => `$${cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2)}`;

/** The words that say what the writer does and costs, fixed (no input is echoed). */
export const STANDIN_WRITER_WORDS = {
  /** On the setup card, before the run: the cost shown first, inside the cap. */
  card: (cents: number, capCents: number, exact = true): string =>
    `Rovara will also write realistic sample data for your tests with your own AI (for example 50 sample profiles that fit your tables): ${exact ? "up to" : "about"} ${standInDollars(cents)}, inside this run's ${standInDollars(capCents)} limit. It never sees a change and never copies a row from your real database.`,
  /** On the card when no AI is connected. */
  noAi: "Rovara writes sample data for your tests with your own AI, and none is connected for this project. Connect your AI first; Rovara never pays for it. Nothing was written and nothing was spent.",
  noRoom: "Rovara did not write sample data: this run's spending limit has no room left for it. Nothing more was spent.",
  nothingToWrite: "Rovara did not write sample data: it found no table or outside service to write it for.",
  unusable: "Rovara did not use the sample data the AI wrote: it did not fit the tables and answers Rovara asked for. Nothing was stored.",
  failed: "Rovara could not write sample data this time. Nothing was stored.",
  written: "Rovara wrote sample data for your tests with your AI, and saved it for this project.",
} as const;

export const STANDIN_SKIP_REASONS = ["no_ai", "no_room", "nothing_to_write", "unusable", "failed"] as const;
export type StandInSkipReason = (typeof STANDIN_SKIP_REASONS)[number];
export const STANDIN_SKIP_WORDS: Readonly<Record<StandInSkipReason, string>> = {
  no_ai: STANDIN_WRITER_WORDS.noAi, no_room: STANDIN_WRITER_WORDS.noRoom, nothing_to_write: STANDIN_WRITER_WORDS.nothingToWrite, unusable: STANDIN_WRITER_WORDS.unusable, failed: STANDIN_WRITER_WORDS.failed,
};

/** What the setup card reads before the run (additive on the setup view; an older reader ignores it). */
export const StandInWriterCardSchema = z.object({
  /** The most the writer can cost, in cents; part of the run's cap, never on top of it. Absent when no AI is connected. */
  ceilingCents: z.number().int().min(0).max(100_000).optional(),
  connected: z.boolean(),
  words: z.string().min(1).max(600),
}).strict();
export type StandInWriterCard = z.infer<typeof StandInWriterCardSchema>;

/**
 * The card's part, from what the broker knows: whether an AI is connected, the run's cap and the model's price when it is known. With the price it says "up to" (the ceiling is a true maximum for that model); without it, "about", at the
 * price of the model Rovara recommends. Either way the run itself holds the line: the writer starts only when ITS ceiling at the real model's price fits in what is left of the cap, and says so in words when it does not.
 */
export function standInWriterCard(input: { connected: boolean; capCents: number; price?: StandInModelPrice | undefined }): StandInWriterCard {
  if (!input.connected) return { connected: false, words: STANDIN_WRITER_WORDS.noAi };
  const exact = input.price !== undefined;
  const ceilingCents = standInWriterCeilingCents(input.price ?? standInReferencePrice());
  // The writer is paid from the run's cap, never on top of it: a ceiling that does not fit in the cap means it will not run, and the card says so instead of promising it.
  if (!Number.isFinite(ceilingCents) || ceilingCents > input.capCents) return { connected: true, words: STANDIN_WRITER_WORDS.noRoom };
  return { connected: true, ceilingCents, words: STANDIN_WRITER_WORDS.card(ceilingCents, input.capCents, exact) };
}
