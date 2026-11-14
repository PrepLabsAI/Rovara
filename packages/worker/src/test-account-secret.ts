// Test services TS27 (design test-services.md 4.3 and 6.2; owner decisions Q3 and Q8 of 2026-11-02): a customer test account's secret, read at RUN TIME into the SEALED check sandbox and nowhere else.
//
// THE RULE. The broker never holds the value (TS26): it mints, for one sealed round, a grant that lets THIS worker read ONE secret for 15 minutes (`TestAccountSecretGrant`). This module turns grants into one
// env file on the worker's tmpfs, hands the file's path to the caller's single `docker exec --env-file`, then overwrites and deletes the file. Around that:
//   - ONLY a sealed check round. Any other place (the setup run, the setup agent, the working sandbox, a task agent, a team runner) is refused before the grant is even parsed: `not_sealed`. The caller names its
//     place; nothing a repository or a model says reaches this parameter;
//   - the value is read once per grant, checked AGAIN by the key-shape rules (a key that turned live-shaped since the save is refused), and every spelling of it is registered with the redactor BEFORE the file is
//     written (`e2eSecretSpellings`: raw, JSON-escaped, percent-encoded, base64 forms and the rest), so anything the test prints while it runs is redacted. The session credentials of the grant are registered too;
//   - the env file lives in a directory the worker owns, on tmpfs (checked: `isTmpfsDirectory` on /proc/self/mountinfo, fail closed), created exclusively with mode 0600 and no symlink, holds only `NAME=value`
//     lines, and is overwritten with zeros and removed when the command ends, whether it passed, failed or threw;
//   - the worker's own process environment is never touched, and no value is ever put in a log, an error or a result: failures are one of the fixed words of `SECRET_REFUSALS`. `withoutTestAccountNames`
//     takes a test account's variable names out of an environment, so no other child process inherits them.
// Nothing here talks to AWS: the caller supplies `read`, which signs with the grant's own credentials. Wiring note: the worker needs `@aws-sdk/client-secrets-manager` for that reader (not a dependency of this
// package yet) and the sealed sandbox (check-sandbox.ts, lane ts-sealed) calls this around its one exec.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, sep } from "node:path";
import { TEST_ACCOUNT_SECRET_VERSION_STAGE, checkTestAccountKeyShape, e2eSecretSpellings, parseTestAccountSecretGrant, type TestAccountSecretGrant } from "@agentx/contracts";

/** Where a command runs. Only a sealed check round may hold a test account's secret. */
export type SecretPlace = "sealed_check" | "setup_run" | "setup_agent" | "working_sandbox" | "task_agent" | "team_runner";

export const SECRET_REFUSALS = ["not_sealed", "bad_grant", "grant_expired", "unreadable", "no_value", "refused_value", "env_conflict", "bad_directory", "leftover_files", "write_failed", "cleanup_failed"] as const;
export type SecretRefusal = (typeof SECRET_REFUSALS)[number];
const WORDS: Record<SecretRefusal, string> = {
  not_sealed: "a test account's secret is available to a sealed check round only",
  bad_grant: "the test account grant is not usable",
  grant_expired: "the test account grant has expired",
  unreadable: "the test account secret could not be read",
  no_value: "the test account secret has no value for its key",
  refused_value: "the test account secret does not look like a test key",
  env_conflict: "two test accounts name the same variable",
  bad_directory: "the secret directory is not a private tmpfs directory of the worker",
  leftover_files: "env files of an earlier round were found and wiped; the round is stopped",
  write_failed: "the test account env file could not be written",
  cleanup_failed: "the test account env file could not be removed",
};

/** A refusal in one of the fixed words. It carries no value, no ARN, no variable name and no message from AWS. */
export class TestAccountSecretError extends Error {
  constructor(readonly code: SecretRefusal) {
    super(WORDS[code]);
    this.name = "TestAccountSecretError";
  }
}

/** The redactor the worker already runs over everything it writes (journals, logs, check output): `register` teaches it one more spelling to hide. */
export interface SecretRedactor { register: (spelling: string) => void }

/**
 * Reads one secret's `SecretString` with the grant's own session credentials. Returns undefined when it is not found. The caller wires the AWS SDK; tests pass a fake. The request MUST carry
 * `VersionStage: versionStage` (AWSCURRENT): the grant's session policy allows a read only for that named stage, so a request that leaves it out is refused, and a pending or previous version is never served.
 */
export type ReadSecret = (grant: Pick<TestAccountSecretGrant, "credentials" | "region" | "secretName"> & { versionStage: typeof TEST_ACCOUNT_SECRET_VERSION_STAGE }) => Promise<string | undefined>;

export interface WithSecretsInput<T> {
  place: SecretPlace;
  /** What the broker sent for this round, unparsed. */
  grants: readonly unknown[];
  now: () => number;
  read: ReadSecret;
  redactor: SecretRedactor;
  /** The directory the env file goes in: absolute, a real directory (not a link), owned by the worker, closed to others, on tmpfs. */
  directory: string;
  /** The check of the directory. Default: `assertPrivateTmpfsDirectory` (Linux, /proc/self/mountinfo). A test passes its own. */
  verifyDirectory?: (directory: string) => void;
  /** Runs the one command with `--env-file <path>`. The path is valid only while this callback runs; undefined when there are no grants (then no flag at all). */
  run: (envFile: string | undefined) => Promise<T>;
}

// ---- the directory

/** The mount point (longest prefix) of a path in `/proc/self/mountinfo` text, and its file system type. */
export function mountOf(mountinfo: string, path: string): { mountPoint: string; type: string } | undefined {
  let best: { mountPoint: string; type: string } | undefined;
  for (const line of mountinfo.split("\n")) {
    // "36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw,errors=continue": the mount point is field 5; the type follows the "-" separator.
    const fields = line.split(" ");
    const dash = fields.indexOf("-");
    if (fields.length < 7 || dash < 6) continue;
    const mountPoint = (fields[4] as string).replace(/\\040/gu, " ");
    const type = fields[dash + 1] as string;
    const within = path === mountPoint || path.startsWith(mountPoint.endsWith("/") ? mountPoint : `${mountPoint}/`);
    if (within && (best === undefined || mountPoint.length >= best.mountPoint.length)) best = { mountPoint, type };
  }
  return best;
}

/** Whether the path is on tmpfs (or ramfs): never on a disk, so a deleted file leaves nothing behind. */
export function isTmpfsDirectory(mountinfo: string, path: string): boolean {
  const mount = mountOf(mountinfo, path);
  return mount !== undefined && (mount.type === "tmpfs" || mount.type === "ramfs");
}

/** An absolute path to a real directory (not a link) that this process's user owns and no one else can enter or change. Throws `bad_directory`. */
export function assertPrivateDirectory(directory: string): void {
  try {
    if (!isAbsolute(directory) || directory.includes("\0")) throw new Error("not absolute");
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not a directory");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("not ours");
    if ((stat.mode & 0o077) !== 0) throw new Error("not private");
  } catch {
    throw new TestAccountSecretError("bad_directory");
  }
}

/** The real check: a private directory of the worker (`assertPrivateDirectory`) on tmpfs, by /proc/self/mountinfo. Fails closed where that cannot be read. Throws `bad_directory`. */
export function assertPrivateTmpfsDirectory(directory: string): void {
  assertPrivateDirectory(directory);
  const onTmpfs = ((): boolean => {
    try {
      return isTmpfsDirectory(readFileSync("/proc/self/mountinfo", "utf8"), directory);
    } catch {
      return false;
    }
  })();
  if (!onTmpfs) throw new TestAccountSecretError("bad_directory");
}

// ---- leftovers

/** The names this module gives its env files: `ta-` and 24 hex digits. Nothing else in the directory is touched. */
const ENV_FILE_NAME = /^ta-[0-9a-f]{24}\.env$/u;

/**
 * Wipes every env file an earlier round left in the directory (a crash, a kill, a failed cleanup): each regular file named like ours is overwritten with zeros and removed; a link or a directory of that name is only
 * removed. Returns how many it found. Called when the worker starts and before every round: any found at a round's start stops the round (`leftover_files`), because something ended without cleaning up.
 * A directory that cannot be listed is `bad_directory`; a file that cannot be wiped is `cleanup_failed`.
 */
export function sweepTestAccountEnvFiles(directory: string): number {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => ENV_FILE_NAME.test(name));
  } catch {
    throw new TestAccountSecretError("bad_directory");
  }
  for (const name of names) {
    const path = join(directory, name);
    try {
      const stat = lstatSync(path);
      if (stat.isFile()) removeFile(path, stat.size);
      else unlinkSync(path);
    } catch {
      throw new TestAccountSecretError("cleanup_failed");
    }
  }
  return names.length;
}

// ---- reading

function parsedGrants(inputs: readonly unknown[], now: number): TestAccountSecretGrant[] {
  const grants: TestAccountSecretGrant[] = [];
  const names = new Set<string>();
  for (const input of inputs) {
    const grant = parseTestAccountSecretGrant(input);
    if (grant === undefined) throw new TestAccountSecretError("bad_grant");
    if (Date.parse(grant.expiresAt) <= now) throw new TestAccountSecretError("grant_expired");
    for (const name of grant.envNames) {
      if (names.has(name)) throw new TestAccountSecretError("env_conflict");
      names.add(name);
    }
    grants.push(grant);
  }
  return grants;
}

const register = (redactor: SecretRedactor, value: string): void => {
  for (const spelling of e2eSecretSpellings(value)) redactor.register(spelling);
};

/** Reads and checks one grant's value. The credentials of the grant are registered first: if anything below throws, they are already hidden. */
async function valueOf(grant: TestAccountSecretGrant, input: Pick<WithSecretsInput<unknown>, "read" | "redactor">): Promise<string> {
  register(input.redactor, grant.credentials.secretAccessKey);
  register(input.redactor, grant.credentials.sessionToken);
  let text: string | undefined;
  try {
    text = await input.read({ credentials: grant.credentials, region: grant.region, secretName: grant.secretName, versionStage: TEST_ACCOUNT_SECRET_VERSION_STAGE });
  } catch {
    throw new TestAccountSecretError("unreadable");
  }
  if (text === undefined) throw new TestAccountSecretError("unreadable");
  // The whole secret text is hidden too, whatever it turns out to hold.
  register(input.redactor, text);
  let value: unknown;
  try {
    value = (JSON.parse(text) as Record<string, unknown>)[grant.key];
  } catch {
    throw new TestAccountSecretError("no_value");
  }
  if (typeof value !== "string" || value === "") throw new TestAccountSecretError("no_value");
  register(input.redactor, value);
  // The save-time check again: a value that looks live now is not put in a sandbox, whatever it looked like when it was saved.
  if (!checkTestAccountKeyShape(grant.family, value).ok) throw new TestAccountSecretError("refused_value");
  return value;
}

// ---- the file

const ZERO_CHUNK = Buffer.alloc(4_096);

function removeFile(path: string, length: number): void {
  // Overwritten first: tmpfs keeps no copy once the file is gone, but a file that outlives its command must hold nothing.
  const fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    for (let written = 0; written < length; written += ZERO_CHUNK.length) writeSync(fd, ZERO_CHUNK, 0, Math.min(ZERO_CHUNK.length, length - written), written);
  } finally {
    closeSync(fd);
  }
  unlinkSync(path);
}

/** `--env-file <path>` for the one `docker exec`, from a path this module made: a plain absolute path with no space or control character, so it is one argument. */
export function dockerEnvFileArgs(envFile: string): string[] {
  if (!isAbsolute(envFile) || /\s/u.test(envFile) || [...envFile].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f) || envFile.includes("=")) throw new TestAccountSecretError("bad_directory");
  return ["--env-file", envFile];
}

/**
 * Resolves the grants into one env file, runs `input.run` with its path, and removes the file whatever happens. Resolves to what `run` resolved to. Order: the place, the grants (parsed, not expired, no variable
 * twice), the directory, every value (read, checked, registered with the redactor), then the file; a refusal at any step writes nothing at all.
 */
export async function withTestAccountSecrets<T>(input: WithSecretsInput<T>): Promise<T> {
  if (input.place !== "sealed_check") throw new TestAccountSecretError("not_sealed");
  const grants = parsedGrants(input.grants, input.now());
  (input.verifyDirectory ?? assertPrivateTmpfsDirectory)(input.directory);
  // Anything an earlier round left is wiped, and this round does not start: a crash that left a secret on disk is a fault to look at, not one to run past.
  if (sweepTestAccountEnvFiles(input.directory) > 0) throw new TestAccountSecretError("leftover_files");
  const lines: string[] = [];
  for (const grant of grants) {
    const value = await valueOf(grant, input);
    for (const name of grant.envNames) lines.push(`${name}=${value}`);
  }
  if (lines.length === 0) return input.run(undefined);
  const body = Buffer.from(`${lines.join("\n")}\n`, "utf8");
  const path = join(input.directory, `ta-${randomBytes(12).toString("hex")}.env`);
  if (!path.startsWith(input.directory.endsWith(sep) ? input.directory : `${input.directory}${sep}`)) throw new TestAccountSecretError("bad_directory");
  let created = false;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try {
        if ((fstatSync(fd).mode & 0o077) !== 0) throw new Error("not private");
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
    } catch {
      throw new TestAccountSecretError("write_failed");
    }
    outcome = { ok: true, value: await input.run(path) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  if (created) {
    try {
      removeFile(path, body.length);
    } catch {
      // A file that could not be removed is the one thing worse than a failed command: say so, in a fixed word, and let the caller stop the round.
      throw new TestAccountSecretError("cleanup_failed");
    }
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** The environment without a test account's variable names, for every other child process: a name is removed whether or not it holds a value. */
export function withoutTestAccountNames(environment: NodeJS.ProcessEnv, grants: readonly Pick<TestAccountSecretGrant, "envNames">[]): NodeJS.ProcessEnv {
  const drop = new Set(grants.flatMap((grant) => grant.envNames));
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !drop.has(name)));
}

/** Which variable names in an environment hold a registered spelling of a value. Names only, never values: for the sealed lane's own check that nothing else carries a secret. */
export function namesHoldingSecret(environment: NodeJS.ProcessEnv, spellings: readonly string[]): string[] {
  const long = spellings.filter((spelling) => spelling.length >= 8);
  return Object.entries(environment).filter(([, value]) => value !== undefined && long.some((spelling) => value.includes(spelling))).map(([name]) => name).sort();
}
