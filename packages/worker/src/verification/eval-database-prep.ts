// L4-E34 (E3): the TEST DATA of an eval's database, one side at a time. Each side (the base commit's and the change's) gets its OWN fresh database, built the same way:
//   1. the project's own MIGRATIONS run on that side (a rollback command never does), so the change's migration is tested for real;
//   2. the project's seeds load, in the order the plan gave (seed files by the no-superuser loader, seed commands by the caller's runner);
//   3. the empty tables get generated rows (`service-seed-generate.ts`): no AI, no clock, no randomness, so an unchanged table has identical rows on both sides, every run.
// Nothing is copied from a customer's real database: a side only ever sees its own fresh database. The report names what was loaded by digest and what was written by table, in fixed words, and gives the digests the stand-in set's
// version is made from (`standInSetVersion`, E4).
//
// THE SEAM (L4-E12). This file does not start a database or attach it to the eval box: the caller (the eval services wiring, branch pr/l4-eval-services-dryrun) gives each side a `StandInDatabasePort`. `postgresStandInDatabase`
// binds one to a started Postgres helper (its container and its own request's credentials) through the existing seed loader, so the wiring has nothing to write but the call.
//
// THE FILL PASS. A lookup that finds no row is something the stand-in database can only know by being watched (the wiring's observer reports it as a `ZeroRowLookup`). `createFillPass` turns what the observer saw into ONE pass:
// the same missing keys are written to BOTH sides' databases (identical rows, by the generator), and the questions that asked are returned for the round to ask again, once, on both sides (`eval-round.ts`, `fillMissingRows`).
import { createHash } from "node:crypto";
import { formatCommandLine, standInSetVersion, type ProjectCommand, type SeedScriptLock } from "@agentx/contracts";
import type { DockerCli } from "../swebench/containers.js";
import { loadSeedFile, readDatabaseText, seedFileDigest, SeedFileError, type SeedFileTarget } from "../service-seed-file.js";
import {
  PLAIN_NAME, STAND_IN_LIMITS, STAND_IN_ROW_GENERATOR_VERSION, STAND_IN_SCHEMA_STATEMENT, parentKeyColumns, parseSampledKeys, parseStandInSchema, planFillForLookups, planStandInRows, sampleKeysStatement,
  type ParentKey, type StandInPlan, type StandInSchema, type StandInSkipReason, type ZeroRowLookup,
} from "../service-seed-generate.js";
import { migrationDirectionOf } from "./migration-check.js";

/** The most steps (migrations and seeds together) one side loads: the contract's seeds-per-dependency limit. */
export const STAND_IN_STEPS_MAX = 8;

/** What one side's database lets the preparation do. */
export interface StandInDatabasePort {
  /** Runs one of the project's own commands (a migration, a seed command) against THIS side's database, where the project's own setup runs. */
  runCommand(command: ProjectCommand, signal: AbortSignal): Promise<{ exitCode: number | null; timedOut: boolean }>;
  /** Loads plain SQL as the no-superuser seed role, in one transaction (`loadSeedFile`). Throws `SeedFileError`. */
  loadSql(bytes: Buffer, signal: AbortSignal): Promise<void>;
  /** One of Rovara's fixed read-only statements, answered as text (`readDatabaseText`). Throws `SeedFileError`. */
  readText(statement: string, signal: AbortSignal): Promise<string>;
}

/** A port over a started Postgres helper: seeds by the existing loader, reads by the owner's local socket. `runCommand` is the caller's (the sandbox or the eval box that runs the project's commands). */
export function postgresStandInDatabase(input: { docker: Pick<DockerCli, "execBytes" | "run">; target: SeedFileTarget; runCommand: StandInDatabasePort["runCommand"] }): StandInDatabasePort {
  return {
    runCommand: input.runCommand,
    loadSql: (bytes, signal) => loadSeedFile(input.docker, input.target, bytes, signal),
    readText: (statement, signal) => readDatabaseText(input.docker, input.target, statement, signal),
  };
}

/** One thing a side loads: a project command (a migration or a seed command) or a repository SQL file's bytes. */
export type StandInStep = { readonly kind: "command"; readonly command: ProjectCommand; readonly lock?: SeedScriptLock } | { readonly kind: "file"; readonly bytes: Buffer };

export type StandInPrepareFailure = "migration_failed" | "migration_timeout" | "migration_rollback" | "seed_failed" | "seed_timeout" | "too_many_steps" | "stopped";
const SENTENCES: Record<StandInPrepareFailure, string> = {
  migration_failed: "A migration did not complete on the test database",
  migration_timeout: "A migration ran out of time on the test database",
  migration_rollback: "A command that rolls migrations back is not run on a test database",
  seed_failed: "A seed did not load into the test database",
  seed_timeout: "A seed ran out of time on the test database",
  too_many_steps: "The test database has more migrations and seeds than a side loads",
  stopped: "The test database preparation was stopped",
};
/** The one error of the preparation: a fixed sentence, never a command's output, a path or a name. */
export class StandInPrepareError extends Error {
  constructor(readonly reason: StandInPrepareFailure) { super(SENTENCES[reason]); this.name = "StandInPrepareError"; }
}

export interface StandInDatabaseReport {
  readonly side: "old" | "new";
  readonly migrations: number;
  readonly seeds: number;
  /** sha-256 (hex) of each seed in load order: a file's bytes, or a seed command's line. Migrations are NOT here: each side runs its own, on purpose. */
  readonly seedDigests: readonly string[];
  readonly generatorVersion: string;
  readonly filled: ReadonlyArray<{ readonly table: string; readonly rows: number }>;
  readonly skipped: ReadonlyArray<{ readonly table: string; readonly reason: StandInSkipReason }>;
}

/** The sha-256 of a seed command's line (what the stand-in set's version binds for a command seed). */
export const seedCommandDigest = (command: ProjectCommand): string => createHash("sha256").update(`rovara-stand-in-seed-command/v1\n${command.cwd}\n${formatCommandLine(command)}`).digest("hex");

/** The result of a fill: what was written, and what was skipped, in fixed words. */
export interface StandInFillResult { readonly filled: ReadonlyArray<{ readonly table: string; readonly rows: number }>; readonly skipped: StandInPlan["skipped"] }
/** One side's way to add the rows that zero-row lookups asked for. */
export interface StandInFiller { readonly side: "old" | "new"; fill(lookups: readonly ZeroRowLookup[], signal: AbortSignal): Promise<StandInFillResult> }

async function readSchema(database: StandInDatabasePort, signal: AbortSignal): Promise<StandInSchema> {
  let schema: StandInSchema | undefined;
  try { schema = parseStandInSchema(JSON.parse(await database.readText(STAND_IN_SCHEMA_STATEMENT, signal))); } catch { schema = undefined; }
  if (signal.aborted) throw new StandInPrepareError("stopped");
  if (schema === undefined) throw new Error("schema_unreadable");
  return schema;
}

async function readKeys(database: StandInDatabasePort, wanted: ReadonlyMap<string, readonly string[]>, signal: AbortSignal): Promise<Map<string, ParentKey[]>> {
  const statement = sampleKeysStatement(wanted);
  if (statement === undefined) return new Map();
  try { return parseSampledKeys(JSON.parse(await database.readText(statement, signal)), wanted); } catch { return new Map(); }
}

/** Loads a plan's statements; false when the database refused them (a plan is best effort: the caller reports the tables as not filled). */
async function loadPlan(database: StandInDatabasePort, plan: StandInPlan, signal: AbortSignal): Promise<boolean> {
  if (plan.sql === "") return true;
  try { await database.loadSql(Buffer.from(plan.sql, "utf8"), signal); return true; } catch { if (signal.aborted) throw new StandInPrepareError("stopped"); return false; }
}

/** A filler for a side whose schema could not be read: it writes nothing. */
const unreadableFiller = (side: "old" | "new"): StandInFiller => ({ side, fill: async () => ({ filled: [], skipped: [{ table: "", reason: "not_filled" }] }) });

/**
 * Prepares ONE side's fresh database. Migrations first (the project's `up` commands, in the order given), then the seeds in the order given, then generated rows for the tables still empty. A failing migration or seed ends the
 * preparation with its fixed reason (the side is then "Not run: Rovara problem" for the caller to say, never a guess). Generated rows are best effort: a table that could not be written is reported, and the others stand.
 */
export async function prepareStandInDatabase(input: { side: "old" | "new"; database: StandInDatabasePort; steps: readonly StandInStep[]; signal: AbortSignal }): Promise<{ report: StandInDatabaseReport; filler: StandInFiller }> {
  const { database, signal } = input;
  if (input.steps.length > STAND_IN_STEPS_MAX) throw new StandInPrepareError("too_many_steps");
  const migrations = input.steps.filter((step): step is Extract<StandInStep, { kind: "command" }> => step.kind === "command" && migrationDirectionOf(step.command) === "up");
  if (input.steps.some(step => step.kind === "command" && migrationDirectionOf(step.command) === "down")) throw new StandInPrepareError("migration_rollback");
  // Migrations build the schema the seeds fill: they run first, whatever order the seeds were found in. The rest keep their order.
  const seeds = input.steps.filter(step => !migrations.includes(step as never));
  const seedDigests: string[] = [];
  const check = (): void => { if (signal.aborted) throw new StandInPrepareError("stopped"); };
  for (const [kind, list] of [["migration", migrations], ["seed", seeds]] as const) {
    for (const step of list) {
      check();
      if (step.kind === "command") {
        const result = await database.runCommand(step.command, signal).catch(() => { check(); throw new StandInPrepareError(kind === "migration" ? "migration_failed" : "seed_failed"); });
        check();
        if (result.timedOut) throw new StandInPrepareError(kind === "migration" ? "migration_timeout" : "seed_timeout");
        if (result.exitCode !== 0) throw new StandInPrepareError(kind === "migration" ? "migration_failed" : "seed_failed");
        if (kind === "seed") seedDigests.push(seedCommandDigest(step.command));
      } else {
        await database.loadSql(step.bytes, signal).catch((error: unknown) => { check(); throw new StandInPrepareError(error instanceof SeedFileError && error.reason === "timeout" ? "seed_timeout" : "seed_failed"); });
        seedDigests.push(seedFileDigest(step.bytes));
      }
    }
  }
  // The migrations and seeds stand. A schema that cannot be read (too large an answer, a shape the parser refuses) only means no generated rows: the side still runs, with a fixed reason in its report.
  let schema: StandInSchema;
  try { schema = await readSchema(database, signal); } catch (error) {
    if (error instanceof StandInPrepareError && error.reason === "stopped") throw error;
    return { report: { side: input.side, migrations: migrations.length, seeds: seeds.length, seedDigests, generatorVersion: STAND_IN_ROW_GENERATOR_VERSION, filled: [], skipped: [{ table: "", reason: "not_filled" }] }, filler: unreadableFiller(input.side) };
  }
  const keys = await readKeys(database, parentKeyColumns(schema), signal);
  const plan = planStandInRows(schema, keys);
  const loaded = await loadPlan(database, plan, signal);
  // The check after the load is best effort too: when it cannot be read the load is unverified, nothing is counted as filled, and the seeds and migrations stand.
  let after: StandInSchema | undefined = schema;
  if (loaded && plan.tables.length > 0) {
    try { after = await readSchema(database, signal); } catch (error) {
      if (error instanceof StandInPrepareError && error.reason === "stopped") throw error;
      after = undefined;
    }
  }
  const stillEmpty = new Set((after ?? schema).tables.filter(table => table.hasRows === false).map(table => table.name));
  const filled = loaded && after !== undefined ? plan.tables.filter(entry => !stillEmpty.has(entry.table)) : [];
  const failed = plan.tables.filter(entry => !filled.some(done => done.table === entry.table)).map(entry => ({ table: entry.table, reason: "not_filled" as const }));
  const report: StandInDatabaseReport = { side: input.side, migrations: migrations.length, seeds: seeds.length, seedDigests, generatorVersion: STAND_IN_ROW_GENERATOR_VERSION, filled, skipped: [...plan.skipped.filter(entry => entry.reason !== "has_rows"), ...failed] };
  const filler: StandInFiller = {
    side: input.side,
    async fill(lookups, fillSignal) {
      const current = await readSchema(database, fillSignal);
      const targets = new Set(lookups.map(lookup => lookup.table));
      // The parents a lookup's row needs: every table with rows that one of the target tables points at.
      const wanted = parentKeyColumns({ ...current, tables: current.tables.map(table => (targets.has(table.name) ? { ...table, hasRows: false } : table)) });
      const existing = await readKeys(database, wanted, fillSignal);
      const written = planFillForLookups(current, lookups, existing);
      const ok = await loadPlan(database, written, fillSignal);
      return { filled: ok ? written.tables : [], skipped: ok ? written.skipped : [...written.skipped, ...written.tables.map(entry => ({ table: entry.table, reason: "not_filled" as const }))] };
    },
  };
  return { report, filler };
}

/**
 * The stand-in set's version of a comparison, or `differs` when the two sides were loaded from different seeds or generators (the comparison would not be on one set of data: the caller says so and does not compare).
 * `images` are the stand-in images' digest references; `answerSets` the digests of any stored answer sets.
 */
export function sharedStandInVersion(reports: readonly StandInDatabaseReport[], parts: { readonly images: readonly string[]; readonly answerSets?: readonly string[] }): { readonly status: "same"; readonly version: string } | { readonly status: "differs" } | { readonly status: "none" } {
  const first = reports[0];
  if (first === undefined) return { status: "none" };
  const same = reports.every(report => report.generatorVersion === first.generatorVersion && report.seedDigests.length === first.seedDigests.length && report.seedDigests.every((digest, i) => digest === first.seedDigests[i]));
  if (!same) return { status: "differs" };
  return { status: "same", version: standInSetVersion({ images: parts.images, seeds: first.seedDigests, generatorVersion: first.generatorVersion, answerSets: parts.answerSets ?? [] }) };
}

/** A zero-row lookup, the question that made it and the side whose code made it. */
export interface ObservedLookup { readonly questionId: string; readonly lookup: ZeroRowLookup; readonly side: "old" | "new" }

const lookupKey = (lookup: ZeroRowLookup): string => `${lookup.table}\u0000${lookup.column}\u0000${String(lookup.value)}`;

/**
 * The round's one fill-and-re-ask pass (`EvalQuestionPlan.fillMissingRows`). Asked once with the ids just run: it takes what the observer saw, writes the same missing rows to BOTH sides (so the sides stay identical), logs each
 * lookup by table and column (never a value), and returns the ids whose lookup was written, for the round to ask again on both sides.
 *
 * ONLY KEYS THE OLD CODE ASKED FOR. A key that only the CHANGE's code looks up could be the change's own mistake (a wrong id, a wrong column); writing a row for it would hide that regression. So a lookup is filled only when the
 * observer also saw the same table, column and value asked by the OLD side (`side: "old"`, from the baseline's or an old re-ask's ledger). A change that asks for a key the old code never needed stays unfilled and is judged as it ran.
 * Re-asked questions are measured on filled data. The observer that reports `side: "old"` lookups (from the old baseline's ledger or an old re-ask) belongs to the services wiring (L4-E12); until it is wired no lookup is
 * filled, which is the safe direction. A second call, an observer that fails, a lookup not in the ids or one that could not be
 * written gives nothing: this pass never stops an eval and never repeats.
 */
export function createFillPass(input: {
  readonly fillers: readonly StandInFiller[];
  observed(ids: readonly string[]): Promise<readonly ObservedLookup[]>;
  readonly signal: AbortSignal;
  readonly log?: (entry: { event: "stand-in.zero-row-lookup" | "stand-in.fill"; table: string; column?: string; side?: "old" | "new"; rows?: number }) => void;
}): (request: { readonly ids: readonly string[] }) => Promise<readonly string[]> {
  let used = false;
  const log: NonNullable<typeof input.log> = entry => { try { input.log?.(entry); } catch { /* logging never changes the answer */ } };
  return async request => {
    if (used) return [];
    used = true;
    try {
      const ids = new Set(request.ids);
      const plain = (await input.observed(request.ids)).filter(item => ids.has(item.questionId) && PLAIN_NAME.test(item.lookup.table) && PLAIN_NAME.test(item.lookup.column));
      const oldKeys = new Set(plain.filter(item => item.side === "old").map(item => lookupKey(item.lookup)));
      const seen = plain.filter(item => oldKeys.has(lookupKey(item.lookup))).slice(0, STAND_IN_LIMITS.lookups);
      if (seen.length === 0) return [];
      for (const item of seen) log({ event: "stand-in.zero-row-lookup", table: item.lookup.table, column: item.lookup.column });
      const lookups = seen.map(item => item.lookup);
      const results: StandInFillResult[] = [];
      for (const filler of input.fillers) {
        if (input.signal.aborted) return [];
        const result = await filler.fill(lookups, input.signal);
        for (const entry of result.filled) log({ event: "stand-in.fill", table: entry.table, side: filler.side, rows: entry.rows });
        results.push(result);
      }
      // A table counts as filled only when EVERY side wrote it: the re-ask is on both sides and the data must be the same.
      const written = results.length === 0 ? new Set<string>() : new Set(results[0]!.filled.map(entry => entry.table).filter(table => results.every(result => result.filled.some(entry => entry.table === table))));
      return [...new Set(seen.filter(item => written.has(item.lookup.table)).map(item => item.questionId))];
    } catch { return []; }
  };
}
