// A bounded, worker-only query ledger for disposable Postgres stand-ins. auto_explain records ACTUAL
// rows (including bound parameters), so no SELECT is re-executed and no customer database is read.
// Only a whole, zero-row, single-table equality scan is understood. Everything else is left alone.
import type { DockerCli } from "../swebench/containers.js";
import type { SeedFileTarget } from "../service-seed-file.js";
import {
  PLAIN_NAME, STAND_IN_LIMITS, STAND_IN_SCHEMA_STATEMENT, parentKeyColumns, parseSampledKeys, parseStandInSchema,
  planFillForLookups, sampleKeysStatement, type ParentKey, type StandInSchema, type ZeroRowLookup,
} from "../service-seed-generate.js";
import { createFillPass, type ObservedLookup, type StandInDatabasePort } from "./eval-database-prep.js";

const MAX_LEDGER_BYTES = 1_048_576;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function zeroRows(text: string): ZeroRowLookup[] {
  if (Buffer.byteLength(text) > MAX_LEDGER_BYTES) return [];
  const lookups: ZeroRowLookup[] = [];
  // PostgreSQL indents continuation lines with a tab on stderr. A truncated JSON plan never matches.
  for (const entry of text.replace(/^\t/gmu, "").matchAll(/plan:\s*\n(\{[\s\S]*?^\})/gmu)) {
    try {
      const record = object(JSON.parse(entry[1]!)); let plan = object(record?.["Plan"]);
      if (typeof record?.["Query Text"] !== "string" || !/^\s*SELECT\b/iu.test(record["Query Text"])) continue;
      // An ORM's LIMIT 1 is a lookup too, provided its scan really ran and also returned zero.
      for (let depth = 0; depth < 4 && plan?.["Node Type"] === "Limit" && plan["Actual Rows"] === 0 && plan["Actual Loops"] === 1; depth += 1) {
        const children = plan["Plans"];
        if (!Array.isArray(children) || children.length !== 1) break;
        plan = object(children[0]);
      }
      if (plan?.["Actual Rows"] !== 0 || plan["Actual Loops"] !== 1 || plan["Schema"] !== "public" || plan["Plans"] !== undefined) continue;
      if (!["Seq Scan", "Index Scan", "Index Only Scan"].includes(String(plan["Node Type"]))) continue;
      const table = plan["Relation Name"]; if (typeof table !== "string" || !PLAIN_NAME.test(table)) continue;
      // Multiple conditions can mean the row was present but another predicate rejected it. Do not fill it.
      const conditions = [plan["Index Cond"], plan["Filter"]].filter(v => v !== undefined);
      if (conditions.length !== 1 || typeof conditions[0] !== "string") continue;
      const match = /^\(\(?(?:"?([A-Za-z_][A-Za-z0-9_]{0,62})"?\.)?"?([A-Za-z_][A-Za-z0-9_]{0,62})"?\)?(?:::text)? = (-?\d+(?:\.\d+)?|'(?:[^']|'')*'(?:::(?:text|uuid|integer|bigint|numeric|character varying))?)\)$/u.exec(conditions[0]);
      if (match === null || (match[1] !== undefined && match[1] !== (plan["Alias"] ?? table))) continue;
      const literal = match[3]!;
      const value = literal.startsWith("'") ? /^'((?:[^']|'')*)'/u.exec(literal)![1]!.replaceAll("''", "'") : Number(literal);
      const unsafeText = typeof value === "string" && (value.length > 200 || value.includes("\\") || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
      if (unsafeText || (typeof value === "number" && !Number.isSafeInteger(value))) continue;
      lookups.push({ table, column: match[2]!, value });
      if (lookups.length === STAND_IN_LIMITS.lookups) break;
    } catch { /* an unreadable plan is no observation */ }
  }
  return lookups;
}

interface Snapshot { schema: StandInSchema; keys: ReadonlyMap<string, readonly ParentKey[]>; observed: readonly ObservedLookup[] }
interface Replay { readonly sql: string; readonly verify: string }
export interface EvalDatabaseRound {
  capture(id: string, side: "old" | "new", snapshot: Snapshot): void;
  replay(side: "old" | "new", id: string): Replay | undefined;
  fillMissingRows(request: { readonly ids: readonly string[] }): Promise<readonly string[]>;
}

/** Databases go away after each run. Plan the one fill from their bounded snapshots, and replay
 * its SQL through the ordinary no-superuser loader in BOTH fresh re-ask databases. A failed replay
 * fails that stage, so the round drops the pass instead of comparing partially filled data. */
export function createEvalDatabaseRound(): EvalDatabaseRound {
  const snapshots = new Map<string, Map<"old" | "new", Snapshot>>();
  const replay = new Map<string, Map<"old" | "new", Replay>>();
  const staged = new Map<string, Map<"old" | "new", { snapshot: Snapshot; lookups: readonly ZeroRowLookup[]; tables: readonly string[] }>>();
  let closed = false;
  const passes = new Map<string, ReturnType<typeof createFillPass>>();
  const signal = new AbortController().signal;
  return {
    capture(id, side, snapshot) {
      if (closed) return;
      if (!snapshots.has(id)) snapshots.set(id, new Map());
      snapshots.get(id)!.set(side, snapshot);
      if (passes.has(id)) return;
      const pending: NonNullable<ReturnType<typeof staged.get>> = new Map();
      passes.set(id, createFillPass({ signal,
        observed: async () => [...snapshots.get(id)!.values()].flatMap(s => s.observed),
        fillers: (["old", "new"] as const).map(side => ({ side, fill: async lookups => {
          const snapshot = snapshots.get(id)?.get(side);
          if (snapshot === undefined) return { filled: [], skipped: [] };
          const plan = planFillForLookups(snapshot.schema, lookups, snapshot.keys);
          pending.set(side, { snapshot, lookups, tables: plan.tables.map(t => t.table) });
          return { filled: plan.tables, skipped: plan.skipped };
        } })),
      }));
      staged.set(id, pending);
    },
    replay: (side, id) => replay.get(id)?.get(side),
    async fillMissingRows(request) {
      closed = true;
      const ids = new Set<string>();
      for (const [id, pass] of passes) {
        const filled = await pass(request);
        if (filled.length === 0) continue;
        const pending = staged.get(id)!;
        const common = pending.get("old")!.tables.filter(table => pending.get("new")!.tables.includes(table));
        replay.set(id, new Map([...pending].map(([side, p]) => {
          const lookups = p.lookups.filter(lookup => common.includes(lookup.table));
          const sql = planFillForLookups(p.snapshot.schema, lookups, p.snapshot.keys).sql;
          const verify = `SELECT ${lookups.map(lookup => `EXISTS (SELECT 1 FROM public."${lookup.table}" WHERE "${lookup.column}" = ${typeof lookup.value === "number" ? String(lookup.value) : `'${lookup.value.replaceAll("'", "''")}'`})`).join(" AND ")}`;
          return [side, { sql, verify }];
        })));
        // A database query has batch scope; conservatively refresh every question in that batch.
        for (const question of request.ids) ids.add(question);
      }
      return [...ids];
    },
  };
}

/** Enable the ledger for NEW sessions of this disposable database's own role only. No new role,
 * grant, extension, network or wire field. Logs stay inside the helper's existing capped log. */
export async function observePostgresLookups(input: {
  docker: Pick<DockerCli, "run">; target: SeedFileTarget & { id: string }; database: StandInDatabasePort;
  round: EvalDatabaseRound; side: "old" | "new"; signal: AbortSignal;
}): Promise<(ids: readonly string[], signal: AbortSignal) => Promise<void>> {
  const { target, docker } = input;
  const none = async (): Promise<void> => undefined;
  if (target.user === undefined || target.database === undefined || !PLAIN_NAME.test(target.user) || !PLAIN_NAME.test(target.database) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(target.container)) return none;
  const settings = { session_preload_libraries: "auto_explain", "auto_explain.log_min_duration": "0", "auto_explain.log_analyze": "on", "auto_explain.log_verbose": "on", "auto_explain.log_timing": "off", "auto_explain.log_format": "json", "auto_explain.sample_rate": "1" };
  try {
    const statements = ["LOAD 'auto_explain'", ...Object.entries(settings).map(([name, value]) => `ALTER ROLE "${target.user}" SET "${name}" = '${value}'`)];
    const enabled = await docker.run(["exec", target.container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", target.user, "-d", target.database, ...statements.flatMap(s => ["-c", s])], { timeoutMs: 10_000, signal: input.signal });
    if (enabled.exitCode !== 0 || input.signal.aborted) return none;
  } catch { return none; }
  return async (ids, signal) => {
    if (signal.aborted || ids.length === 0) return;
    try {
      const result = await docker.run(["logs", "--tail", "2000", target.container], { timeoutMs: 10_000, signal });
      if (result.exitCode !== 0 || result.timedOut === true || signal.aborted) return;
      const lookups = zeroRows(`${result.stdout}\n${result.stderr}`);
      if (lookups.length === 0) return;
      const schema = parseStandInSchema(JSON.parse(await input.database.readText(STAND_IN_SCHEMA_STATEMENT, signal)));
      if (schema === undefined) return;
      const wanted = parentKeyColumns({ ...schema, tables: schema.tables.map(t => ({ ...t, hasRows: false })) });
      const statement = sampleKeysStatement(wanted);
      const keys = statement === undefined ? new Map() : parseSampledKeys(JSON.parse(await input.database.readText(statement, signal)), wanted);
      // A batch has no per-query question tag. Conservatively re-ask the entire batch; never invent a
      // narrower attribution. Only keys also seen on OLD can be filled (createFillPass's guard).
      const observed = lookups.map(lookup => ({ questionId: ids[0]!, lookup, side: input.side }));
      input.round.capture(target.id, input.side, { schema, keys, observed });
    } catch { /* observer failure never changes an eval answer */ }
  };
}
