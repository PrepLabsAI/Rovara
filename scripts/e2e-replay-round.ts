// M1.4 Task 4.6b: asks for the audit replay of a task's qualified AI-navigated round, then waits for its record and prints it.
//
//   npx tsx scripts/e2e-replay-round.ts --env agentxlivetest123 --task <task-id> --round <round-id> [--profile <aws profile>] [--region <region>] [--poll-seconds 15] [--timeout-minutes 40] [--no-wait]
//
// What it does (and all it does): `agentx admin task e2e-replay start`, then `agentx admin task e2e-replay show` until the attempt it started is recorded or could not be run. Both are
// administrator commands on the control plane, run through the CLI with your admin sign-in (`agentx --env <env> login --admin`). The replay runs the round's candidate again with no model,
// serving only the recordings the verified round left; its result is a record kept apart from the task. This script never retries, cancels, approves, sends a task back or publishes
// anything: it cannot change a task's verdict, and neither can the replay.
//
// Exit codes: 0 when the replay was recorded (whether or not it reproduced the round: that is information), 1 when it could not be run or did not finish in time, 2 when the request was
// refused or the arguments are wrong. Nothing is printed but the broker's own answers (state, times, status, reproduced, downloadSha256Match and a fixed reason code).
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface ReplayArgs { env: string; task: string; round: string; profile?: string; region?: string; pollSeconds: number; timeoutMinutes: number; wait: boolean }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENV_NAME = /^[a-z][a-z0-9-]{1,40}$/;

export function parseReplayArgs(argv: readonly string[]): ReplayArgs {
  const values = new Map<string, string>();
  let wait = true;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--no-wait") { if (!wait) throw new Error(`${argument} was given twice`); wait = false; continue; }
    if (!["--env", "--task", "--round", "--profile", "--region", "--poll-seconds", "--timeout-minutes"].includes(argument)) throw new Error(`unknown option ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (values.has(argument)) throw new Error(`${argument} was given twice`);
    values.set(argument, value);
    index += 1;
  }
  const required = (name: string): string => { const value = values.get(name); if (value === undefined) throw new Error(`${name} is required`); return value; };
  const env = required("--env");
  const task = required("--task");
  const round = required("--round");
  if (!ENV_NAME.test(env)) throw new Error("--env must be an environment name");
  if (!UUID.test(task) || !UUID.test(round)) throw new Error("--task and --round must be IDs, such as 44444444-4444-4444-8444-444444444444");
  const number = (name: string, fallback: number, min: number, max: number): number => {
    const text = values.get(name);
    if (text === undefined) return fallback;
    const parsed = Number(text);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
    return parsed;
  };
  return { env, task, round, ...(values.has("--profile") ? { profile: values.get("--profile")! } : {}), ...(values.has("--region") ? { region: values.get("--region")! } : {}),
    pollSeconds: number("--poll-seconds", 15, 1, 300), timeoutMinutes: number("--timeout-minutes", 40, 1, 120), wait };
}

/** What a CLI call answered: its exit status and JSON output. */
export type CliResult = { status: number; stdout: string; stderr: string };
export interface ReplayDependencies {
  /** Runs `agentx --json --env <env> <arguments>`. The script only ever passes `admin task e2e-replay start` and `admin task e2e-replay show`. */
  cli(argumentsList: readonly string[]): CliResult;
  sleep(ms: number): Promise<void>;
  now(): number;
  out(text: string): void;
  err(text: string): void;
}

type Json = Record<string, unknown>;
const parse = (text: string): Json | undefined => { try { const value: unknown = JSON.parse(text); return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : undefined; } catch { return undefined; } };
/** The answer's own error, as the CLI prints it, or the CLI's stderr: a fixed code and sentence; nothing else of the answer is ever echoed. */
const refusalOf = (result: CliResult): string => {
  const body = parse(result.stdout) ?? parse(result.stderr);
  const error = body?.["error"] as { code?: unknown; message?: unknown } | undefined;
  return typeof error?.message === "string" ? error.message.slice(0, 300) : result.stderr.trim().slice(0, 300) || `exit ${result.status}`;
};

/** The fields of a replay record the operator is shown. */
const VIEW_FIELDS = ["attempt", "state", "requestedAt", "startedAt", "recordedAt", "reason", "replay"] as const;
export const viewOfRecord = (record: Json): Json => Object.fromEntries(VIEW_FIELDS.flatMap((name) => (record[name] === undefined ? [] : [[name, record[name]] as const])));

export async function runReplayRound(args: ReplayArgs, dependencies: ReplayDependencies): Promise<number> {
  const target = ["--task", args.task, "--round", args.round];
  const started = dependencies.cli(["admin", "task", "e2e-replay", "start", ...target]);
  const answer = parse(started.stdout);
  const replay = answer?.["replay"] as { attempt?: unknown; sourceRoundId?: unknown } | undefined;
  if (started.status !== 0 || typeof replay?.attempt !== "number") {
    dependencies.err(`the replay was refused: ${refusalOf(started)}`);
    return 2;
  }
  const attempt = replay.attempt;
  dependencies.err(`replay attempt ${attempt} of round ${args.round} started; nothing about the task changes whatever it finds`);
  const deadline = dependencies.now() + args.timeoutMinutes * 60_000;
  for (;;) {
    const shown = dependencies.cli(["admin", "task", "e2e-replay", "show", "--task", args.task, "--round", args.round]);
    const records = (parse(shown.stdout)?.["replays"] as Json[] | undefined) ?? [];
    const mine = records.find((item) => item["attempt"] === attempt);
    if (shown.status === 0 && mine !== undefined) {
      if (mine["state"] === "RECORDED" || mine["state"] === "UNAVAILABLE" || !args.wait) {
        dependencies.out(JSON.stringify(viewOfRecord(mine), null, 2));
        return mine["state"] === "RECORDED" ? 0 : mine["state"] === "UNAVAILABLE" ? 1 : 0;
      }
    }
    if (!args.wait) { dependencies.out(JSON.stringify({ attempt, state: "STARTED" }, null, 2)); return 0; }
    if (dependencies.now() >= deadline) { dependencies.err(`the replay did not finish within ${args.timeoutMinutes} minutes; read it later with: agentx --env ${args.env} admin task e2e-replay show --task ${args.task} --round ${args.round}`); return 1; }
    await dependencies.sleep(args.pollSeconds * 1000);
  }
}

const REPO_ROOT = join(import.meta.dirname, "..");
export function realDependencies(args: ReplayArgs): ReplayDependencies {
  return {
    cli: (argumentsList) => {
      const result = spawnSync("node", [join(REPO_ROOT, "packages/cli/dist/bin.js"), "--json", "--env", args.env, ...argumentsList], {
        cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, ...(args.profile === undefined ? {} : { AWS_PROFILE: args.profile }), ...(args.region === undefined ? {} : { AWS_REGION: args.region }) } });
      return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
    now: () => Date.now(), out: (text) => console.log(text), err: (text) => console.error(text),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let args: ReplayArgs;
  try { args = parseReplayArgs(process.argv.slice(2)); } catch (error) { console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`); process.exit(2); }
  runReplayRound(args, realDependencies(args)).then((code) => { process.exitCode = code; }, (error: unknown) => { console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
