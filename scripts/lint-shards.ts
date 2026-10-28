// Lints the whole repository in shards, with the same eslint.config.js and so the same rules and the same files as `eslint .`.
//
// Why: with the type-aware rules, one eslint process over the whole repository builds a single TypeScript program over every file
// of tsconfig.lint.json and keeps it, plus the lint state of every file, in one heap. That needed more than 6 GB. Here each shard is
// its own eslint process over one group of directories, and gets its own, smaller TypeScript program: a tsconfig generated next to
// the others in node_modules/.cache/lint-shards/ that extends tsconfig.lint.json (so every compiler option is the same) and includes
// only that group's files. The program still follows imports out of the group for type information; it just does not hold the rest.
// eslint.config.js reads the program's path from the LINT_SHARD_PROJECT environment variable and, when it is not set (an editor, a
// plain `npx eslint file`), falls back to tsconfig.lint.json as before.
//
// The last shard is a catch-all: eslint's own ignore patterns leave out the directories the other shards name and it lints everything
// else, so a new directory is linted by it instead of being missed. tests/contract/lint-shards.test.ts proves, with eslint's own file
// enumeration, that the shards together lint exactly the files `eslint .` lints, each once, and that every shard's program contains them.
//
// Node runs this file directly, so only erasable syntax. Usage, from the repository root, after `tsc -b` (the packages import each other
// through their built declarations):
//   node scripts/lint-shards.ts [--list] [--only <shard>[,<shard>...]] [--jobs <n>] [--heap <MB>]
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The environment variable eslint.config.js reads the shard's TypeScript program from. */
export const PROJECT_ENV = "LINT_SHARD_PROJECT";
/** The heap cap of one shard's eslint process. The biggest shards peak at about 3.5 GB of memory in all; see docs/development.md. */
export const DEFAULT_HEAP_MB = 4096;
/** The name of the last shard, which lints everything the other shards do not name. */
export const REST = "rest";
/** Where the generated tsconfig files go: ignored by git, and inside the repository so TypeScript finds node_modules/@types from there. */
export const PROGRAM_DIRECTORY = "node_modules/.cache/lint-shards";

/**
 * The shards before the catch-all. A shard is a group of paths linted together, and a path is a directory ("packages/broker") or, to
 * split a big directory, a glob over the files directly in it ("tests/contract/a*.ts"; only `*` and `?`, which eslint, the ignore
 * patterns and a tsconfig `include` all read the same way). tests/contract is split by the first letter of the file name: the
 * biggest shard bounds the memory of the whole run, and one process over all of tests/contract peaked at 4.5 GB. Anything in no
 * group (a file in tests/contract that starts with a digit, a new directory, files at the root) is linted by the last shard.
 */
export const SHARD_DIRECTORIES: readonly { name: string; directories: readonly string[] }[] = [
  { name: "tests-contract-a-d", directories: ["tests/contract/a*.ts", "tests/contract/b*.ts", "tests/contract/c*.ts", "tests/contract/d*.ts"] },
  { name: "tests-contract-e-j", directories: ["tests/contract/e*.ts", "tests/contract/f*.ts", "tests/contract/g*.ts", "tests/contract/h*.ts", "tests/contract/i*.ts", "tests/contract/j*.ts"] },
  { name: "tests-contract-l-p", directories: ["tests/contract/l*.ts", "tests/contract/m*.ts", "tests/contract/n*.ts", "tests/contract/o*.ts", "tests/contract/p*.ts"] },
  { name: "tests-contract-r-s", directories: ["tests/contract/r*.ts", "tests/contract/s*.ts"] },
  { name: "tests-contract-t-z", directories: ["tests/contract/t*.ts", "tests/contract/u*.ts", "tests/contract/v*.ts", "tests/contract/w*.ts"] },
  { name: "tests-unit", directories: ["tests/unit"] },
  { name: "tests-integration", directories: ["tests/integration"] },
  { name: "tests-support", directories: ["tests/support"] },
  { name: "broker", directories: ["packages/broker"] },
  { name: "cli", directories: ["packages/cli"] },
  { name: "worker", directories: ["packages/worker"] },
  { name: "verifier", directories: ["packages/verifier"] },
  { name: "contracts", directories: ["packages/contracts"] },
  { name: "small-packages", directories: ["packages/gateway", "packages/mcp", "packages/model-runtime", "packages/orchestrator", "packages/slack-service"] },
  { name: "infra-scripts", directories: ["infra", "scripts"] },
];

export interface Shard {
  name: string;
  /** What eslint is given on the command line: the group's paths, or "." for the last shard. */
  targets: readonly string[];
  /** eslint ignore patterns (the last shard only): the directories the other shards lint. */
  ignore: readonly string[];
  /** The TypeScript program's include patterns, relative to the repository root. */
  include: readonly string[];
  /** The TypeScript program's exclude patterns, relative to the repository root, besides the ones tsconfig.lint.json has. */
  exclude: readonly string[];
}

const isGlob = (path: string): boolean => path.endsWith(".ts");
/** A path as a TypeScript `include`/`exclude` pattern and as an eslint ignore pattern: a directory means everything under it. */
const everything = (path: string): string => (isGlob(path) ? path : `${path}/**`);
const programPattern = (path: string): string => (isGlob(path) ? path : `${path}/**/*.ts`);

/** The shards, in the order they are started: the groups, then the catch-all. */
export function planShards(): Shard[] {
  const named = SHARD_DIRECTORIES.flatMap((group) => group.directories);
  return [
    ...SHARD_DIRECTORIES.map((group): Shard => ({
      name: group.name,
      targets: group.directories,
      ignore: [],
      include: group.directories.map(programPattern),
      exclude: [],
    })),
    { name: REST, targets: ["."], ignore: named.map(everything), include: ["**/*.ts"], exclude: named.map(everything) },
  ];
}

/** The tsconfig of a shard's program. It extends tsconfig.lint.json and changes nothing but which files are in it. */
export function shardTsconfig(shard: Shard, root: string): object {
  const base = JSON.parse(readFileSync(join(root, "tsconfig.lint.json"), "utf8")) as { exclude?: string[] };
  // The paths of an `extends`-ed file's `include`/`exclude` are relative to that file, but ours are written elsewhere: make them absolute.
  const absolute = (pattern: string): string => `${root.replaceAll("\\", "/")}/${pattern}`;
  return {
    extends: resolve(root, "tsconfig.lint.json"),
    include: shard.include.map(absolute),
    exclude: [...(base.exclude ?? []), ...shard.exclude].map(absolute),
  };
}

/** Writes the shard's tsconfig and returns its path. */
export function writeShardTsconfig(shard: Shard, root: string): string {
  const directory = join(root, PROGRAM_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${shard.name}.json`);
  writeFileSync(file, `${JSON.stringify(shardTsconfig(shard, root), null, 2)}\n`);
  return file;
}

/** Node's arguments for one shard's eslint run. Only the heap cap, the ignore patterns and the targets differ between shards. */
export function eslintArguments(eslintBin: string, shard: Shard, heapMb: number): string[] {
  return [`--max-old-space-size=${heapMb}`, eslintBin, ...shard.ignore.flatMap((pattern) => ["--ignore-pattern", pattern]), ...shard.targets];
}

/**
 * How many shards to run at once. A shard peaks near 3.5 GB, so two at a time fit a 16 GB runner (which has 4 cores) with room to spare,
 * and anything smaller runs them one at a time. More would only help on a machine that has nothing else to do, and a busy one can say
 * `--jobs 1`.
 */
export function defaultJobs(totalMemoryBytes: number, cores: number): number {
  return totalMemoryBytes >= 14 * 1024 ** 3 && cores >= 4 ? 2 : 1;
}

export interface Options { list: boolean; heapMb: number; jobs?: number; only?: ReadonlySet<string>; eslintBin?: string }

export function parseOptions(argv: readonly string[]): Options | string {
  const options: Options = { list: false, heapMb: DEFAULT_HEAP_MB };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--list") options.list = true;
    else if (arg === "--heap") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 512) return "--heap needs a number of megabytes, at least 512";
      options.heapMb = value;
    } else if (arg === "--jobs") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 8) return "--jobs needs a whole number from 1 to 8";
      options.jobs = value;
    } else if (arg === "--only") {
      const value = argv[++index];
      if (value === undefined || value === "") return "--only needs a comma-separated list of shard names";
      options.only = new Set(value.split(","));
    } else if (arg === "--eslint-bin") {
      const value = argv[++index];
      if (value === undefined || value === "") return "--eslint-bin needs a path";
      options.eslintBin = value;
    } else return `Unknown option ${arg}. Usage: node scripts/lint-shards.ts [--list] [--only <shard>[,<shard>...]] [--jobs <n>] [--heap <MB>]`;
  }
  return options;
}

export interface ShardResult {
  shard: Shard;
  /** The exit status; null when the process did not exit by itself (see `signal`, `error`). */
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  seconds: number;
  /** Everything the process printed, in order. */
  output: string;
}

/** The command's exit code: 0 only if at least one shard ran and every shard that ran exited 0. A crash or a missing result is a failure. */
export function exitCodeFor(results: readonly ShardResult[]): 0 | 1 {
  return results.length > 0 && results.every((result) => result.status === 0 && result.error === undefined) ? 0 : 1;
}

/**
 * Runs every shard, at most `jobs` at a time, and returns the results in the order of `shards`. A failing shard does not stop the
 * others: one run reports every problem. `report` is called as each shard finishes.
 */
export async function runShards(shards: readonly Shard[], jobs: number, run: (shard: Shard) => Promise<ShardResult>, report: (result: ShardResult) => void = () => undefined): Promise<ShardResult[]> {
  const results: ShardResult[] = new Array<ShardResult>(shards.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < shards.length) {
      const index = next++;
      const result = await run(shards[index]!);
      results[index] = result;
      report(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, shards.length) }, worker));
  return results;
}

function runEslint(root: string, eslintBin: string, heapMb: number, shard: Shard): Promise<ShardResult> {
  const started = Date.now();
  const finish = (partial: Pick<ShardResult, "status" | "output"> & Partial<ShardResult>): ShardResult => ({ shard, seconds: (Date.now() - started) / 1000, ...partial });
  return new Promise((done) => {
    let output = "";
    let project: string;
    try { project = writeShardTsconfig(shard, root); } catch (error) { done(finish({ status: null, output, error: `could not write the shard's tsconfig: ${String(error)}` })); return; }
    // Only this variable differs between shards; eslint.config.js reads it. NODE_OPTIONS (a caller may set a larger heap) never loosens
    // the cap: Node takes the command-line flag over it.
    const child = spawn(process.execPath, eslintArguments(eslintBin, shard, heapMb), { cwd: root, env: { ...process.env, [PROJECT_ENV]: project }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("error", (error) => { done(finish({ status: null, output, error: String(error) })); });
    child.on("close", (status, signal) => { done(finish({ status, signal, output })); });
  });
}

function describeResult(result: ShardResult): string {
  const ok = result.status === 0 && result.error === undefined;
  const lines = [`${ok ? "ok  " : "FAIL"} ${result.shard.name} (${result.seconds.toFixed(0)}s)`];
  if (result.output.trim() !== "") lines.push(result.output.trimEnd());
  if (result.signal !== undefined && result.signal !== null) {
    lines.push(`eslint was stopped by ${result.signal}.${result.signal === "SIGABRT" ? ` Node aborts when its heap is full: the cap is --max-old-space-size in eslintArguments (scripts/lint-shards.ts). If one shard needs more, split its directories in SHARD_DIRECTORIES.` : ""}`);
  }
  if (result.error !== undefined) lines.push(result.error);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (typeof options === "string") { console.error(options); process.exitCode = 2; return; }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const all = planShards();
  const unknown = [...(options.only ?? [])].filter((name) => !all.some((shard) => shard.name === name));
  if (unknown.length > 0) { console.error(`No such shard: ${unknown.join(", ")}. Shards: ${all.map((shard) => shard.name).join(", ")}`); process.exitCode = 2; return; }
  const selected = all.filter((shard) => options.only === undefined || options.only.has(shard.name));
  if (options.list) { console.log(selected.map((shard) => `${shard.name}: ${shard.targets.join(" ")}${shard.ignore.length > 0 ? ` (leaving out ${shard.ignore.length} directories the other shards lint)` : ""}`).join("\n")); return; }

  const jobs = options.jobs ?? defaultJobs(totalmem(), availableParallelism());
  const eslintBin = options.eslintBin ?? join(root, "node_modules/eslint/bin/eslint.js");
  const started = Date.now();
  const results = await runShards(selected, jobs, (shard) => runEslint(root, eslintBin, options.heapMb, shard), (result) => { console.log(describeResult(result)); });
  const failed = results.filter((result) => result.status !== 0 || result.error !== undefined);
  console.log(`${results.length - failed.length} of ${results.length} lint shards passed in ${((Date.now() - started) / 1000).toFixed(0)}s (${jobs} at a time).`);
  if (failed.length > 0) console.error(`Failed: ${failed.map((result) => result.shard.name).join(", ")}`);
  process.exitCode = exitCodeFor(results);
}

// Usage: node scripts/lint-shards.ts [options], from the repository root, after tsc -b
if (process.argv[1]?.endsWith("lint-shards.ts")) await main();
