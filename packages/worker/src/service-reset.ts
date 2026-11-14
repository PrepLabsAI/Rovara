// Seeds and reset hooks (test services, TS18; design test-services.md 4.0.6 step 4 and 4.1.2). A run's helpers are seeded once (the dependency's seeds, in order, as the project's own commands in the sandbox), and a helper that a
// round resets between checks is put back by the catalog entry's reset kind:
//
//   template_db  Postgres: right after the seeds the seeded database is renamed to `<db>_seeded` and marked a template; a reset drops the working database and copies the template. The seeded data is kept.
//   flush        Redis: FLUSHALL. The data is gone: the seeds run again.
//   http_reset   Rovara local AWS: `POST /__rovara/reset` on its control path. The data is gone: the seeds run again.
//   restart      `docker restart`, then the health wait. The data is gone: the seeds run again.
//
// The hooks plug into the ServiceRunner (service-runner.ts) as `resetHooks`; the order of a reset (helpers in start order, reseed what a kind lost) is `resetForNextCheck`, and a round that wants everything fresh
// (the TESTPROOF original-code rerun, a new check round) is `freshHelpers`.
//
// Rules this module keeps, each with a test:
//   - Nothing a repository wrote reaches a Docker argument or a SQL line: a database and a user come from the helper's own request (checked against the launcher's plain patterns), and every statement is built from those and fixed words.
//   - No secret is an argument. The Postgres hook talks over the container's local socket (no password). The Redis hook reads its password from the config file inside the container. The control call's token goes in an env file on
//     the run's tmpfs (mode 0600), removed as soon as the call has returned.
//   - A seed is a command the sandbox runs through a port (the sandbox is not here), a seed that fails ends the run of seeds at once, and every failure is one fixed sentence that never carries a command's output.
//   - NOT HERE, a TS30 wiring item: the seeding of a Prove run. `seedRun` (seeds, then `seeded`) must be called once after the helpers start, by whoever wires Prove's boot step; Prove's own ports (service-runner.ts) only start and probe.
//   - A reset kind with no hook, or a hook that fails, is a refusal, never a silent skip (`ServiceRunnerError`).
import { randomBytes } from "node:crypto";
import type { ProjectCommand, SeedScriptLock, TaskDependencyPlan } from "@agentx/contracts";
import { HELPER_CREDENTIAL_PATTERNS, controlCallArgs, type HelperFiles } from "./service-helpers.js";
import type { ResetContext, ResetHook, ResetHooks, ResetOutcome, ServiceSession } from "./service-runner.js";

/** A seed as a plan carries it: a command, or a repository file with (from an approved environment) the sha256 its approval bound. */
export type SeedRef = TaskDependencyPlan["seeds"][number];
export type FileSeedRef = Extract<SeedRef, { fixturePath: string }>;
export type SeedFailure = "seed_failed" | "seed_timeout" | "stopped" | "seed_changed" | "seed_meta_command" | "seed_program" | "seed_not_allowed";

/** The one error of the seeds. `message` is a fixed sentence; a command's output and a file's path never go in it. */
export class SeedError extends Error {
  constructor(readonly reason: SeedFailure) {
    super(SEED_SENTENCES[reason]);
    this.name = "SeedError";
  }
}
const SEED_SENTENCES: Record<SeedFailure, string> = {
  seed_failed: "A test service's seed did not complete",
  seed_timeout: "A test service's seed ran out of time",
  stopped: "The test services' seeds were stopped",
  seed_changed: "A test service's seed file or seed script changed since the test environment was approved; check it works and approve it again",
  seed_meta_command: "A test service's seed file holds a psql command (a backslash, as in \\copy, \\! or a pg_dump COPY FROM stdin block); a seed file is plain SQL only",
  seed_program: "A test service's seed file uses COPY ... PROGRAM, which a seed file may not run",
  seed_not_allowed: "A test service's seed file runs a statement the seed role may not run: it has no superuser rights (no file reads, server programs or extensions)",
};
/** The seed failure a file seed's refusal is told as (review: one message per reason; anything else is the generic one). */
const FILE_SEED_FAILURES: Readonly<Record<string, SeedFailure>> = { changed: "seed_changed", meta_command: "seed_meta_command", program: "seed_program", not_allowed: "seed_not_allowed" };

/** What the sandbox does for the seeds: the project's own commands run there, and a repository fixture file is applied to the dependency that reads it. */
export interface SeedPorts {
  runCommand(command: ProjectCommand, signal: AbortSignal): Promise<{ exitCode: number | null; timedOut: boolean }>;
  /** Loads a file seed; a file whose content differs from the one its approval bound throws an error whose `reason` is `changed`. */
  applyFixture(dependencyId: string, seed: FileSeedRef, signal: AbortSignal): Promise<void>;
  /**
   * SEED-RISK-1: whether a LOCKED seed command's script is still exactly what was approved, hashed again from the checkout now (service-seed-lock.ts). Asked before every run of a locked seed; absent, a locked seed
   * is refused (it never runs unchecked).
   */
  lockHolds?(command: ProjectCommand, lock: SeedScriptLock): Promise<boolean>;
}

/** The most seeds one dependency holds (the contract's own limit, checked again here). */
export const MAX_SEEDS_PER_DEPENDENCY = 8;

/** Runs one dependency's seeds in order and stops at the first that fails. */
export async function runSeeds(dependencyId: string, seeds: readonly SeedRef[], ports: SeedPorts, signal: AbortSignal): Promise<void> {
  if (seeds.length > MAX_SEEDS_PER_DEPENDENCY) throw new SeedError("seed_failed");
  for (const seed of seeds) {
    if (signal.aborted) throw new SeedError("stopped");
    if ("command" in seed) {
      if (seed.lock !== undefined && (ports.lockHolds === undefined || !await ports.lockHolds(seed.command, seed.lock).catch(() => false))) throw new SeedError("seed_changed");
      const result = await ports.runCommand(seed.command, signal).catch(() => { throw new SeedError(signal.aborted ? "stopped" : "seed_failed"); });
      if (signal.aborted) throw new SeedError("stopped");
      if (result.timedOut) throw new SeedError("seed_timeout");
      if (result.exitCode !== 0) throw new SeedError("seed_failed");
    } else {
      await ports.applyFixture(dependencyId, seed, signal).catch((error: unknown) => { throw new SeedError(signal.aborted ? "stopped" : fileSeedFailureOf(error)); });
    }
  }
}

/** The seed failure of a file seed's error: its own reason's message, or the generic one. */
function fileSeedFailureOf(error: unknown): SeedFailure {
  const reason = (error as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && Object.hasOwn(FILE_SEED_FAILURES, reason) ? FILE_SEED_FAILURES[reason]! : "seed_failed";
}

/** Runs a dependency's `prepare` step, if it has one. A failure is the fixed `seed_failed` (what failed is the emulator's business; its words never go on). */
async function prepareDependency(dependency: ResetDependency, signal: AbortSignal): Promise<void> {
  if (dependency.prepare === undefined) return;
  if (signal.aborted) throw new SeedError("stopped");
  await dependency.prepare(signal).catch(() => { throw new SeedError(signal.aborted ? "stopped" : "seed_failed"); });
}

export interface ResetDependency {
  id: string;
  seeds: readonly SeedRef[];
  /** `fresh_per_round`: a new helper each round, no reset between checks. `between_checks`: put back between the round's checks. */
  reset: "fresh_per_round" | "between_checks";
  /**
   * Runs before the dependency's seeds, every time they are about to run (after the start, and after a reset that lost the data): creates what the seed commands expect to find. Rovara local AWS creates the project's declared
   * tables, buckets and queues here (service-seed-aws.ts); a failure ends the run of seeds like a failed seed command. Absent for every other dependency.
   */
  prepare?(signal: AbortSignal): Promise<void>;
}

type Seedable = Pick<ServiceSession, "reset" | "seeded"> & Partial<Pick<ServiceSession, "enterCheckRound">>;

/**
 * After a run starts: every dependency's seeds, in the order given (the start order), then the session is told each one is seeded (a Postgres makes its template then). A dependency with no seeds is still told: a
 * template of an empty database is still the reset point.
 */
export async function seedRun(session: Seedable, dependencies: readonly ResetDependency[], ports: SeedPorts, signal: AbortSignal): Promise<void> {
  for (const dependency of dependencies) {
    await prepareDependency(dependency, signal);
    await runSeeds(dependency.id, dependency.seeds, ports, signal);
    await session.seeded(dependency.id, signal);
  }
}

/**
 * Between two checks of one round: every `between_checks` dependency is reset, in the order given, and a dependency whose reset lost its data is seeded again (and told so). `fresh_per_round` dependencies are left alone.
 * The first failure ends it; nothing is retried here.
 */
export async function resetForNextCheck(session: Seedable, dependencies: readonly ResetDependency[], ports: SeedPorts, signal: AbortSignal): Promise<void> {
  await resetThenReseed(session, dependencies.filter((dependency) => dependency.reset === "between_checks"), ports, signal);
}

/** For a round that must not see the last one's state (a new check round, the TESTPROOF original-code rerun): every dependency, whatever its reset mode, is put back and reseeded where it lost its data. */
export async function freshHelpers(session: Seedable, dependencies: readonly ResetDependency[], ports: SeedPorts, signal: AbortSignal): Promise<void> {
  // The order is the point (L6): the working sandbox leaves the network FIRST, then the helpers are put back, then the checks run. A sandbox still attached could write to a helper while it is being reset.
  await session.enterCheckRound?.(signal);
  await resetThenReseed(session, dependencies, ports, signal);
}

async function resetThenReseed(session: Seedable, dependencies: readonly ResetDependency[], ports: SeedPorts, signal: AbortSignal): Promise<void> {
  for (const dependency of dependencies) {
    if (signal.aborted) throw new SeedError("stopped");
    const outcome: ResetOutcome = await session.reset(dependency.id, signal);
    if (outcome.keptSeeds) continue;
    await prepareDependency(dependency, signal);
    await runSeeds(dependency.id, dependency.seeds, ports, signal);
    await session.seeded(dependency.id, signal);
  }
}

// ---- the hooks

const RESTART_TIMEOUT_S = 1;
const RESTART_WAIT_FALLBACK_MS = 60_000;
const RESTART_POLL_MS = 500;
const EXEC_TIMEOUT_MS = 30_000;
/** The emulator fork's control path (design 5.4, as built: `/_rovara/`, one underscore). */
export const RESET_PATH = "/_rovara/reset";
const SEEDED_SUFFIX = "_seeded";

async function exec(context: ResetContext, args: string[]): Promise<string> {
  const result = await context.docker.run(["exec", context.helper.container, ...args], { timeoutMs: EXEC_TIMEOUT_MS }).catch(() => ({ exitCode: -1, stdout: "" }));
  if (result.exitCode !== 0) throw new Error("exec");
  return result.stdout;
}

/** The database, user and template names of a Postgres helper: its own request's, checked against the launcher's plain patterns, and short enough for a `_seeded` suffix. */
function postgresNames(context: ResetContext): { user: string; database: string; template: string } {
  const user = context.request.credentials?.user;
  const database = context.request.credentials?.database;
  if (user === undefined || database === undefined || !HELPER_CREDENTIAL_PATTERNS.user.test(user)) throw new Error("names");
  // Postgres' own template databases are never the working database: renaming or dropping them would break every later CREATE DATABASE.
  if (database === "template0" || database === "template1") throw new Error("names");
  // The template name is the database name plus a suffix, so the one pattern check below covers both (a longer valid name has a valid prefix, and a prefix with a quote or a space is not valid).
  const template = `${database}${SEEDED_SUFFIX}`;
  if (!HELPER_CREDENTIAL_PATTERNS.database.test(template)) throw new Error("names");
  return { user, database, template };
}

/** `psql` over the container's own socket, one `-c` per statement (each runs outside a transaction block, which `DROP DATABASE` and `CREATE DATABASE` need). */
function psql(user: string, connectTo: string, statements: readonly string[]): string[] {
  return ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", connectTo, ...statements.flatMap((statement) => ["-c", statement])];
}
const disconnect = (database: string): string => `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid()`;

/** `template_db`: after the seeds, rename the seeded database to the template and copy it back; between checks, drop the working copy and copy the template again. The seeded data is kept. */
export const templateDbHook: ResetHook = async (context) => {
  const { user, database, template } = postgresNames(context);
  // The control connection must not be to the database being renamed or dropped: that is `postgres`, unless `postgres` IS the working database (the image's default name), when it is `template1`.
  const connectTo = database === "postgres" ? "template1" : "postgres";
  if (context.phase === "seeded") {
    await exec(context, psql(user, connectTo, [
      disconnect(database), `ALTER DATABASE "${database}" RENAME TO "${template}"`, `ALTER DATABASE "${template}" WITH IS_TEMPLATE true`, `ALTER DATABASE "${template}" WITH ALLOW_CONNECTIONS false`,
      `CREATE DATABASE "${database}" TEMPLATE "${template}"`,
    ]));
    return;
  }
  await exec(context, psql(user, connectTo, [disconnect(database), `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`, `CREATE DATABASE "${database}" TEMPLATE "${template}"`]));
  return { keptSeeds: true };
};

/** The cache CLI line, fixed. The password is read inside the container from the config file the launcher mounted; it is never an argument. Valkey's image ships `valkey-cli`, Redis' `redis-cli`. */
const flushScript = (cli: "redis-cli" | "valkey-cli"): string => `REDISCLI_AUTH="$(sed -n 's/^requirepass //p' /etc/rovara/redis.conf)" VALKEYCLI_AUTH="$REDISCLI_AUTH" ${cli} flushall`;
export const REDIS_FLUSH_SCRIPT = flushScript("redis-cli");
export const VALKEY_FLUSH_SCRIPT = flushScript("valkey-cli");

/** `flush`: FLUSHALL, and the CLI must say `OK` (an error line with exit status 0 is a failed flush). The data is gone. */
export const flushHook: ResetHook = async (context) => {
  if (context.phase === "seeded") return;
  const output = await exec(context, ["sh", "-c", /valkey/u.test(context.request.entry.id) ? VALKEY_FLUSH_SCRIPT : REDIS_FLUSH_SCRIPT]);
  if (output.trim() !== "OK") throw new Error("flush");
  return { keptSeeds: false };
};

/** `restart`: restart the container and wait until it is healthy again, at most the catalog entry's own `startTimeoutS`. The data is gone. The helper's bind-mounted files stay until the run stops (service-helpers.ts), so the restart finds them. */
export const restartHook: ResetHook = async (context) => {
  if (context.phase === "seeded") return;
  const restarted = await context.docker.run(["restart", "--time", String(RESTART_TIMEOUT_S), context.helper.container], { timeoutMs: EXEC_TIMEOUT_MS }).catch(() => ({ exitCode: -1 }));
  if (restarted.exitCode !== 0) throw new Error("restart");
  const startTimeoutS = context.request.entry.health.startTimeoutS;
  const deadline = context.now() + (Number.isFinite(startTimeoutS) && startTimeoutS > 0 ? startTimeoutS * 1_000 : RESTART_WAIT_FALLBACK_MS);
  for (;;) {
    if (context.signal?.aborted === true) throw new Error("stopped");
    const remaining = deadline - context.now();
    if (remaining <= 0) throw new Error("health");
    if (await context.health(remaining)) return { keptSeeds: false };
    await context.sleep(Math.max(1, Math.min(RESTART_POLL_MS, deadline - context.now())));
  }
};

export interface HttpResetOptions {
  /** The run's directory seam: the control token is written there for the one call. */
  files: HelperFiles;
  /** The worker's own image (digest or id): the control call is made from a container of it, like a health probe. */
  probeImage: string;
  /** Overrides where the token comes from. Default: the one the runner put on the context (`context.controlToken`, the request's `credentials.controlToken`, for an `http_reset` helper only). */
  controlToken?(context: ResetContext): string | undefined;
}

/**
 * `http_reset`: `POST /_rovara/reset` on the emulator, with the per-run control token in the `x-rovara-control-token` header (the fork's control API), made from a hardened container of the worker's image on the services network (the worker cannot reach an `rvi*` bridge). The token is in an env file that
 * exists only for the call. The data is gone.
 */
export function httpResetHook(options: HttpResetOptions): ResetHook {
  return async (context) => {
    if (context.phase === "seeded") return;
    const token = options.controlToken === undefined ? context.controlToken : options.controlToken(context);
    const port = context.request.entry.run.ports[0];
    if (token === undefined || !HELPER_CREDENTIAL_PATTERNS.password.test(token) || port === undefined) throw new Error("token");
    const name = `${context.helper.container}-r${randomBytes(4).toString("hex")}`;
    const fileName = `${name}.env`;
    const path = await options.files.write(fileName, `ROVARA_CONTROL_TOKEN=${token}\n`, 0o600);
    try {
      const args = controlCallArgs(context.network, { probeImage: options.probeImage, address: context.helper.address, port, path: RESET_PATH, name, envFile: path });
      const result = await context.docker.run(args, { timeoutMs: EXEC_TIMEOUT_MS }).catch(() => ({ exitCode: -1 }));
      if (result.exitCode !== 0) {
        await context.docker.run(["rm", "--force", "--volumes", name], { timeoutMs: EXEC_TIMEOUT_MS }).catch(() => undefined);
        throw new Error("reset");
      }
    } finally {
      await options.files.remove(fileName).catch(() => undefined);
    }
    return { keptSeeds: false };
  };
}

/** The four kinds, ready to hand to the runner. `http` is needed only when an `http_reset` entry can be in the run. */
export function createResetHooks(options: { http?: HttpResetOptions } = {}): ResetHooks {
  return {
    template_db: templateDbHook,
    flush: flushHook,
    restart: restartHook,
    ...(options.http === undefined ? {} : { http_reset: httpResetHook(options.http) }),
  };
}
