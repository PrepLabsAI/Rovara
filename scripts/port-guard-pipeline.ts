// The release pipeline's way to run the port guard with the controller's private name list (L14).
//
// The list is one regular expression per line and must never enter the repository or a log. It lives in an SSM SecureString in the release account; this
// script receives only the parameter's NAME (PORT_GUARD_NAMES_PARAMETER), fetches and decrypts the value inside the step, writes it to a private temporary
// file (directory 0700, file 0600), points the guard at it (PORT_GUARD_PRIVATE_NAMES) and deletes the file when the guard returns. The value is never
// printed: not on success, not on a failed fetch (the aws CLI's own message is dropped and only its error code is kept), not in a finding (the guard prints
// file:line and a pattern number). It FAILS CLOSED: no parameter name, a failed fetch, an empty list or an unreadable list is exit 2, never a run with only
// the built-in list (the guard is started with --require-private-names, so it refuses the degraded mode too).
//
// Usage (from the checkout, in the pipeline step, after `set +x`):
//   PORT_GUARD_NAMES_PARAMETER=<ssm parameter name> node scripts/port-guard-pipeline.ts [guard arguments, e.g. --range origin/mainline..HEAD]
// Node runs this file directly, so only erasable syntax and only Node's own modules; the guard runs as a child process for the same reason.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const NAMES_PARAMETER_ENV = "PORT_GUARD_NAMES_PARAMETER";

/** A failure that is safe to print: its message never holds the list. */
export class NamesError extends Error {}

/** Returns the decrypted value of the named parameter, or throws a NamesError whose message holds no value. */
export type NamesFetcher = (parameterName: string, env: NodeJS.ProcessEnv) => string;

/** `aws ssm get-parameter --with-decryption`, stdout captured (never inherited), stderr reduced to the error code. */
export const fetchWithAwsCli: NamesFetcher = (parameterName, env) => {
  const result = spawnSync(
    "aws",
    ["ssm", "get-parameter", "--name", parameterName, "--with-decryption", "--query", "Parameter.Value", "--output", "text"],
    { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.error !== undefined || result.status !== 0) {
    const code = /An error occurred \(([A-Za-z0-9]+)\)/.exec(result.stderr ?? "")?.[1];
    const how = result.error !== undefined ? "the aws CLI could not run" : `the aws CLI exited ${result.status}${code === undefined ? "" : ` (${code})`}`;
    throw new NamesError(`could not fetch the extended name list from SSM: ${how}`);
  }
  return result.stdout;
};

/** The guard as its own process: its stdout and stderr go straight to the step's log, and the list's path reaches it only through its environment. */
const runGuardProcess = (argv: readonly string[], env: NodeJS.ProcessEnv): number => {
  const result = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "port-guard.ts"), ...argv], { env, stdio: "inherit" });
  return result.status ?? 2;
};

export interface PipelineGuardOptions {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  fetch: NamesFetcher;
  /** Runs the guard (default: node scripts/port-guard.ts as a child process, output passed through); replaced in tests. */
  guard?: (argv: readonly string[], env: NodeJS.ProcessEnv) => number;
  /** Where the temporary directory goes; replaced in tests. */
  tempRoot?: string;
  /** Receives the temp file's path while it exists; tests only. */
  onFile?: (file: string) => void;
}

/** Exit status: the guard's (0 clean, 1 findings), or 2 when the list could not be loaded or the guard could not run. */
export function runPipelineGuard(options: PipelineGuardOptions): number {
  const { argv, env, fetch, guard = runGuardProcess } = options;
  const parameterName = (env[NAMES_PARAMETER_ENV] ?? "").trim();
  if (parameterName === "") {
    console.error(`port-guard: the extended name list is required and ${NAMES_PARAMETER_ENV} is not set; refusing to run with only the built-in list.`);
    return 2;
  }
  let value: string;
  try {
    value = fetch(parameterName, env);
  } catch (error) {
    console.error(`port-guard: ${error instanceof NamesError ? error.message : "could not fetch the extended name list"}; refusing to run with only the built-in list.`);
    return 2;
  }
  const patterns = value.split(/\r?\n/).filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  // `aws --output text` prints the word None for a null value; as a pattern it would match ordinary text.
  if (patterns.length === 0 || (patterns.length === 1 && patterns[0]!.trim() === "None")) {
    console.error("port-guard: the extended name list from SSM holds no patterns; refusing to run with only the built-in list.");
    return 2;
  }
  const dir = mkdtempSync(join(options.tempRoot ?? tmpdir(), "port-guard-names-"));
  try {
    chmodSync(dir, 0o700);
    const file = join(dir, "names.txt");
    writeFileSync(file, value.endsWith("\n") ? value : `${value}\n`, { mode: 0o600 });
    options.onFile?.(file);
    return guard([...argv, "--require-private-names"], { ...env, PORT_GUARD_PRIVATE_NAMES: file, PORT_GUARD_REQUIRE_PRIVATE_NAMES: "1" });
  } catch (error) {
    console.error(`port-guard: ${error instanceof Error ? error.constructor.name : "error"} while running the guard with the extended name list.`);
    return 2;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("port-guard-pipeline.ts")) {
  process.exitCode = runPipelineGuard({ argv: process.argv.slice(2), env: process.env, fetch: fetchWithAwsCli });
}
