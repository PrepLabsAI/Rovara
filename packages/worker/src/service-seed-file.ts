// File seeds (TS-UX-1 item 9; SECURITY-SENSITIVE): a dependency's `seeds[].fixturePath` is a repository file of SQL, run by the test database's own client (`psql`) inside the dependency's container, against the run's
// own DISPOSABLE test database, as a role with no superuser rights. It is SQL, so it can do whatever that role may do in that database; it cannot reach the network or a Rovara secret.
//
// Rules, each with a test (tests/unit/worker-service-seed-file.test.ts):
//   - THE FILE IS THE REPOSITORY'S. The path (relative, checked by the contract) is resolved to its real path, which must be a regular file under one of the REPOSITORIES' own folders (each resolved too), never under a hidden
//     folder of the workspace (the worker's state, the agent's sessions, the Docker data root); `..` and a symlink that points outside are refused by that, a symlink inside the repository to a file inside it is allowed. It
//     is opened without following a link, the opened file must be the very file that was resolved (device and inode), and on Linux the opened descriptor's own path (`/proc/self/fd/<fd>`) is checked again, so a parent
//     folder swapped for a link between the check and the open is refused (review M1).
//   - BOUND TO THE APPROVAL (review I3, owner decision 12, SEED-FILE-LOCK). The file's sha256 is what an approval binds: a plan from an approved environment names it, and a file whose content differs (in the checkout or in
//     the candidate tree the agent wrote) is refused, asking for a fresh approval. A candidate check's plan names none: it loads the file and reports the sha256 it loaded, which the approval then binds.
//   - PLAIN SQL ONLY (review I2). A file with a backslash (a psql meta-command such as `\!`, `\c` or `\copy`, which psql reads anywhere outside a quoted string) or the word PROGRAM (`COPY ... PROGRAM`) is refused before
//     anything runs. At most `SEED_FILE_MAX_BYTES`; `.sql` only; Postgres only. Any other family is refused (`unsupported`), never guessed.
//   - NO SUPERUSER (review I2). The SQL runs as a fresh role made for this one load, with a random name no repository can plant: LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS, granted only
//     `pg_read_all_data`, `pg_write_all_data` and USAGE/CREATE on schema public. So no `COPY ... PROGRAM`, `pg_read_file`, server-side `lo_import`, `CREATE EXTENSION` or role change. The role's objects are handed to
//     the database's owner and the role is dropped after the load, whatever happened.
//   - NO NETWORK, NO SECRET. `psql` runs in the helper's own container over its local socket (no host, no port, no password). The file's bytes go on stdin; nothing of them is an argument, a log line or an error. Every
//     statement Rovara itself runs is built from fixed words and names checked against the launcher's plain patterns.
//   - BOUNDED (review M2). One transaction (`--single-transaction`, `ON_ERROR_STOP=1`): a bad statement loads nothing. The time limit runs INSIDE the container (`timeout -s KILL`) and as the role's
//     `statement_timeout`; on a timeout or a cancel the role's backends are also terminated, so nothing keeps running in the database after Rovara gave up.
//   - FIXED WORDS. Every failure is a `SeedFileError` with a fixed reason; the run sees only the seeds' fixed sentence.
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readlink, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { DockerCli } from "./swebench/containers.js";
import { HELPER_CREDENTIAL_PATTERNS } from "./service-helpers.js";

/** The most a seed file may hold. */
export const SEED_FILE_MAX_BYTES = 5 * 1_048_576;
/** The longest one file may take to load. */
export const SEED_FILE_TIMEOUT_MS = 5 * 60_000;
/** Each statement Rovara itself runs around a load (make the role, terminate its backends, drop it). */
const CONTROL_TIMEOUT_MS = 30_000;
/** The families whose own client loads a file, and the extension each takes. */
const FILE_SEED_FAMILIES: Readonly<Record<string, string>> = { postgres: ".sql" };

export type SeedFileFailure = "outside" | "not_a_file" | "too_large" | "unsupported" | "meta_command" | "program" | "not_allowed" | "changed" | "load_failed" | "timeout";
export class SeedFileError extends Error {
  constructor(readonly reason: SeedFileFailure) {
    super(reason === "changed" ? "A test service's seed file changed since the test environment was approved" : "A test service's seed file did not load");
    this.name = "SeedFileError";
  }
}

const within = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}${sep}`);

/** The path a descriptor is open on, on Linux; undefined where the system cannot say (macOS). */
async function procFdPath(fd: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  return readlink(`/proc/self/fd/${String(fd)}`);
}

/**
 * The bytes of a seed file, or a `SeedFileError`: the real path must be a regular file inside a repository folder and outside every hidden folder, with the family's extension and at most `SEED_FILE_MAX_BYTES`, the file
 * opened (without following a link) must be the one resolved, and where the system names an open descriptor's path (`fdPath`, Linux by default), that path must be the resolved one.
 */
export async function readSeedFile(input: { rootPath: string; repositoryPaths: readonly string[]; hiddenPaths: readonly string[]; fixturePath: string; family: string; fdPath?: (fd: number) => Promise<string | undefined> }): Promise<Buffer> {
  const extension = FILE_SEED_FAMILIES[input.family];
  if (extension === undefined) throw new SeedFileError("unsupported");
  if (input.fixturePath.startsWith("/") || input.fixturePath.split(/[\\/]/u).includes("..") || input.fixturePath.includes("\0")) throw new SeedFileError("outside");
  let real: string;
  let repositories: string[];
  let hidden: string[];
  try {
    repositories = (await Promise.all(input.repositoryPaths.map((path) => realpath(path).catch(() => undefined)))).filter((path): path is string => path !== undefined);
    hidden = await Promise.all(input.hiddenPaths.map((path) => realpath(path).catch(() => path)));
    real = await realpath(resolve(input.rootPath, input.fixturePath));
  } catch {
    throw new SeedFileError("not_a_file");
  }
  // Strictly inside a repository folder (never the folder itself), and never inside a hidden one.
  const contained = (path: string): boolean => repositories.some((folder) => path.startsWith(`${folder}${sep}`)) && !hidden.some((folder) => within(path, folder));
  if (!contained(real)) throw new SeedFileError("outside");
  if (!real.toLowerCase().endsWith(extension)) throw new SeedFileError("unsupported");
  let resolvedInfo: { dev: number; ino: number };
  try { resolvedInfo = await stat(real); } catch { throw new SeedFileError("not_a_file"); }
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch { throw new SeedFileError("not_a_file"); }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== resolvedInfo.dev || info.ino !== resolvedInfo.ino) throw new SeedFileError("not_a_file");
    // M1: a parent folder swapped for a link after the realpath is caught here: the descriptor's own path must still be the resolved, contained one.
    const opened = await (input.fdPath ?? procFdPath)(handle.fd).catch(() => null);
    if (opened === null || (opened !== undefined && (opened !== real || !contained(opened)))) throw new SeedFileError("outside");
    if (info.size > SEED_FILE_MAX_BYTES) throw new SeedFileError("too_large");
    const bytes = await handle.readFile();
    // The file may have grown since the size was read.
    if (bytes.length > SEED_FILE_MAX_BYTES) throw new SeedFileError("too_large");
    return bytes;
  } catch (error) {
    throw error instanceof SeedFileError ? error : new SeedFileError("not_a_file");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The sha256 of a seed file's bytes, as an approval binds it. */
export const seedFileDigest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/**
 * I2: what the SQL may not hold, before anything runs. A backslash anywhere (psql reads a meta-command such as `\!` or `\c` wherever it is outside a quoted string, so the whole file is refused rather than parsed) and the
 * word PROGRAM (`COPY ... FROM PROGRAM`) are refused; the role it runs as could not run either, and this says why in fixed words.
 */
export function seedFileContentProblem(bytes: Buffer): "meta_command" | "program" | undefined {
  const text = bytes.toString("utf8");
  if (text.includes("\\")) return "meta_command";
  if (/\bprogram\b/iu.test(text)) return "program";
  return undefined;
}

/** The helper a file loads into: its container, family, and the database and (superuser) user of its own request. */
export interface SeedFileTarget { container: string; family: string; user: string | undefined; database: string | undefined }

/** The names a load uses, checked against the launcher's plain patterns: the database, its owner (the image's superuser), the container and this load's own role. */
function namesOf(target: SeedFileTarget, role: string): { owner: string; database: string; role: string } {
  if (FILE_SEED_FAMILIES[target.family] === undefined) throw new SeedFileError("unsupported");
  const { user, database } = target;
  if (user === undefined || database === undefined || !HELPER_CREDENTIAL_PATTERNS.user.test(user) || !HELPER_CREDENTIAL_PATTERNS.database.test(database)) throw new SeedFileError("unsupported");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(target.container)) throw new SeedFileError("unsupported");
  if (!/^rovara_seed_[a-f0-9]{12}$/u.test(role) || role === user) throw new SeedFileError("unsupported");
  return { owner: user, database, role };
}

/** A fresh role name for one load: random, so no repository can have made it beforehand. */
export const seedRoleName = (): string => `rovara_seed_${randomBytes(6).toString("hex")}`;

/** `psql` as the database's owner over the container's socket, one `-c` per fixed statement. */
const controlArgs = (container: string, owner: string, database: string, statements: readonly string[]): string[] =>
  ["exec", container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", owner, "-d", database, ...statements.flatMap((statement) => ["-c", statement])];

/** The statements that make this load's role: no superuser rights, read and write on the data, create in schema public, a statement limit. Built only from checked names. */
export function seedRoleStatements(names: { role: string; database: string }, timeoutMs: number): string[] {
  return [
    `CREATE ROLE "${names.role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    `GRANT pg_read_all_data, pg_write_all_data TO "${names.role}"`,
    `GRANT USAGE, CREATE ON SCHEMA public TO "${names.role}"`,
    `ALTER ROLE "${names.role}" SET statement_timeout = ${String(Math.max(1, Math.floor(timeoutMs)))}`,
  ];
}

/** The `psql` call that runs the file on stdin as this load's role: the helper's local socket (no host, port or password), one transaction, stop at the first error, no startup file, killed inside the container at the limit. */
export function seedFileLoadArgs(target: SeedFileTarget, role: string, timeoutMs: number = SEED_FILE_TIMEOUT_MS): string[] {
  const names = namesOf(target, role);
  return ["exec", "-i", target.container, "timeout", "-s", "KILL", String(Math.max(1, Math.ceil(timeoutMs / 1000))), "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-U", names.role, "-d", names.database, "-f", "-"];
}

/**
 * Loads the bytes into the helper's database: the content is screened, a role is made for the load, the file runs as that role, and the role is dropped (its objects handed to the owner) whatever happened. A content
 * problem, a non-zero exit (a bad statement: nothing is kept, one transaction), a timeout or a cancel is a `SeedFileError`. On a timeout or a cancel the role's backends are terminated first.
 */
export async function loadSeedFile(docker: Pick<DockerCli, "execBytes" | "run">, target: SeedFileTarget, bytes: Buffer, signal: AbortSignal, options: { role?: string; timeoutMs?: number } = {}): Promise<void> {
  const problem = seedFileContentProblem(bytes);
  if (problem !== undefined) throw new SeedFileError(problem);
  const timeoutMs = options.timeoutMs ?? SEED_FILE_TIMEOUT_MS;
  const names = namesOf(target, options.role ?? seedRoleName());
  const execBytes = docker.execBytes;
  if (execBytes === undefined) throw new SeedFileError("unsupported");
  const control = async (statements: readonly string[]): Promise<boolean> => {
    const result = await docker.run(controlArgs(target.container, names.owner, names.database, statements), { timeoutMs: CONTROL_TIMEOUT_MS }).catch(() => undefined);
    return result !== undefined && result.exitCode === 0;
  };
  const roleStatements = seedRoleStatements(names, timeoutMs);
  if (!await control(roleStatements.slice(0, 1))) throw new SeedFileError("load_failed");
  const grants = roleStatements.slice(1);
  /** The load itself, as this load's role; the failure it came to, or undefined. */
  const runLoad = async (): Promise<SeedFileError | undefined> => {
    const result = await execBytes.call(docker, seedFileLoadArgs(target, names.role, timeoutMs), { stdin: bytes, signal, timeoutMs: timeoutMs + 10_000, maxStdoutBytes: 64 * 1_024 }).catch(() => undefined);
    if (result === undefined) return new SeedFileError("load_failed");
    // `timeout -s KILL` ends psql with 137; the local client's own limit is a backstop.
    if (result.timedOut === true || result.exitCode === 137) return new SeedFileError("timeout");
    if (result.aborted === true || signal.aborted) return new SeedFileError("load_failed");
    // A statement the seed role may not run (a superuser-only function, a file read): said as its own reason. Only this fixed match of psql's own error is read, never shown.
    if (result.exitCode !== 0) return new SeedFileError(/permission denied|must be superuser|must be owner|insufficient privilege/iu.test(result.stderr) ? "not_allowed" : "load_failed");
    return undefined;
  };
  let failure: SeedFileError | undefined;
  try {
    // The role exists from here: whatever fails next (a grant included), it is dropped in the finally below.
    if (!await control(grants)) failure = new SeedFileError("load_failed");
    else failure = await runLoad();
  } finally {
    // Nothing of the load keeps running after Rovara gave up on it.
    if (failure !== undefined || signal.aborted) await control([`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${names.role}'`]);
    const dropped = await control([`REASSIGN OWNED BY "${names.role}" TO "${names.owner}"`, `DROP OWNED BY "${names.role}"`, `DROP ROLE "${names.role}"`]);
    if (failure === undefined && !dropped) failure = new SeedFileError("load_failed");
  }
  if (failure !== undefined) throw failure;
}
