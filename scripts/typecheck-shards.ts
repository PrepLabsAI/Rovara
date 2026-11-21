// Type-checks tests/ and scripts/ in parallel incremental shards (issue #1327), replacing the monolithic 12 GB `tsc -p tsconfig.lint.json` pass.
//
// Why: `npm run typecheck` (`tsc -b`) already type-checks and emits declarations for every package and infra/. Running one `tsc -p tsconfig.lint.json`
// process over the whole repository re-parsed all package sources and every test file in one single-threaded 12 GB heap (~5 minutes on CI).
// Here each shard is a smaller incremental `--noEmit` program (`node_modules/.cache/tsc-shards/<shard>.json`) that references the built packages and
// writes its own `.tsbuildinfo` file so CI can cache and reuse it across runs. The last shard (`rest`) is a catch-all so new folders under `tests/`
// are never missed, and `verifyCoverage` proves every file in `tsconfig.lint.json` is covered by `tsconfig.json` or a shard.
//
// Node runs this file directly, so only erasable syntax. Usage, from the repository root, after `tsc -b`:
//   node scripts/typecheck-shards.ts [--list] [--only <shard>[,<shard>...]] [--jobs <n>] [--heap <MB>] [--timeout <seconds>]
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as TypeScript from "typescript";

export const PROGRAM_DIRECTORY = "node_modules/.cache/tsc-shards";
export const DEFAULT_HEAP_MB = 4096;
export const DEFAULT_TIMEOUT_SECONDS = 600;
export const REST = "rest";
const LINT_CONFIG = "tsconfig.lint.json";
const ROOT_SOLUTION = "tsconfig.json";

const letterGlobs = (dir: string, letters: string): string[] => [...letters].map((letter) => `${dir}/${letter}*.ts`);

const UNIT_FIRST_FOLDERS = [
  "tests/unit/context-sources",
  "tests/unit/contracts",
  "tests/unit/intake",
  "tests/unit/knowledge",
  "tests/unit/knowledge-wiring",
] as const;

const UNIT_SECOND_FOLDERS = [
  "tests/unit/lessons",
  "tests/unit/lessons-by-area",
  "tests/unit/support",
  "tests/unit/task-log",
] as const;

export const SHARD_GROUPS: readonly { name: string; paths: readonly string[] }[] = [
  { name: "unit-a-k", paths: [...letterGlobs("tests/unit", "abcdefghijk"), ...UNIT_FIRST_FOLDERS] },
  { name: "unit-l-z", paths: [...letterGlobs("tests/unit", "lmnopqrstuvwxyz"), ...UNIT_SECOND_FOLDERS] },
  { name: "contract-a-m", paths: letterGlobs("tests/contract", "abcdefghijklm") },
  { name: "contract-n-z", paths: letterGlobs("tests/contract", "nopqrstuvwxyz") },
];

export interface Shard {
  name: string;
  include: readonly string[];
  exclude: readonly string[];
}

export interface TscRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type RunVerdict = { ok: true } | { ok: false; reason: string };

export interface ShardResult extends TscRun {
  shard: Shard;
  seconds: number;
  verdict: RunVerdict;
}

export interface Options {
  list: boolean;
  heapMb: number;
  timeoutSeconds?: number;
  jobs?: number;
  only?: ReadonlySet<string>;
  tscBin?: string;
}

const isGlob = (path: string): boolean => path.endsWith(".ts");
const includePattern = (path: string): string => (isGlob(path) ? path : `${path}/**/*.ts`);
const excludePattern = (path: string): string => (isGlob(path) ? path : `${path}/**`);

/** The shards to run: each named group, followed by the catch-all (`rest`) covering scripts/, root vitest configs, and any other tests/ folder. */
export function planShards(): Shard[] {
  const named = SHARD_GROUPS.flatMap((group) => group.paths);
  return [
    ...SHARD_GROUPS.map((group): Shard => ({
      name: group.name,
      include: group.paths.map(includePattern),
      exclude: [],
    })),
    {
      name: REST,
      include: ["scripts/**/*.ts", "tests/**/*.ts", "vitest.config.ts", "vitest.coverage-map.config.ts"],
      exclude: named.map(excludePattern),
    },
  ];
}

/** Package and infra project references read from the root tsconfig.json, resolved to absolute paths. */
export function rootReferences(root: string): string[] {
  const parsed = JSON.parse(readFileSync(join(root, ROOT_SOLUTION), "utf8")) as { references?: Array<{ path: string }> };
  return (parsed.references ?? []).map((ref) => resolve(root, ref.path).replaceAll("\\", "/"));
}

/** The generated tsconfig for one shard: inherits strict checks from tsconfig.base.json, uses incremental --noEmit, and reads built package declarations. */
export function shardTsconfig(shard: Shard, root: string, references: readonly string[] = rootReferences(root)): object {
  const base = JSON.parse(readFileSync(join(root, LINT_CONFIG), "utf8")) as { exclude?: string[] };
  const slashRoot = root.replaceAll("\\", "/");
  const abs = (pattern: string): string => `${slashRoot}/${pattern}`;
  return {
    extends: resolve(root, "tsconfig.base.json"),
    compilerOptions: {
      composite: false,
      declaration: false,
      declarationMap: false,
      disableSourceOfProjectReferenceRedirect: true,
      incremental: true,
      noEmit: true,
      rootDir: slashRoot,
      tsBuildInfoFile: `./${shard.name}.tsbuildinfo`,
    },
    include: shard.include.map(abs),
    exclude: [...(base.exclude ?? []), ...shard.exclude].map(abs),
    references: references.map((path) => ({ path })),
  };
}

/** Writes the shard's tsconfig atomically and returns its path. */
export function writeShardTsconfig(shard: Shard, root: string, references: readonly string[] = rootReferences(root)): string {
  const directory = join(root, PROGRAM_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${shard.name}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(shardTsconfig(shard, root, references), null, 2)}\n`);
  renameSync(temporary, file);
  return file;
}

/** Node's arguments for one shard's tsc run. */
export function tscArguments(tscBin: string, projectPath: string, heapMb = DEFAULT_HEAP_MB): string[] {
  return [`--max-old-space-size=${heapMb}`, tscBin, "-p", projectPath, "--pretty", "false"];
}

/** Two shards at a time fit comfortably in a 16 GB / 4-core runner (~3.9 GB peak per cold shard); smaller machines run one at a time. */
export function defaultJobs(totalMemoryBytes: number, cores: number): number {
  return totalMemoryBytes >= 14 * 1024 ** 3 && cores >= 4 ? 2 : 1;
}

/** Judges one tsc invocation: exit 0 with empty stdout and stderr is the only clean pass. */
export function interpretTscRun(run: TscRun): RunVerdict {
  if (run.error !== undefined) return { ok: false, reason: `tsc could not run: ${run.error}` };
  if (run.signal === "SIGABRT") {
    return { ok: false, reason: "tsc was stopped by SIGABRT (likely out of memory; raise --heap or split the shard in scripts/typecheck-shards.ts)." };
  }
  if (run.signal !== null) return { ok: false, reason: `tsc was stopped by ${run.signal}` };
  if (run.status === null) return { ok: false, reason: "tsc exited without an exit code" };
  if (run.stderr.trim() !== "") return { ok: false, reason: `tsc wrote to stderr:\n${run.stderr.trim()}` };
  if (run.status === 0) return run.stdout.trim() === "" ? { ok: true } : { ok: false, reason: `tsc exited 0 but printed output:\n${run.stdout.trim()}` };
  return { ok: false, reason: run.stdout.trim() || `tsc exited with code ${run.status} and printed no errors` };
}

function parseIntFlag(raw: string | undefined, min: number, max: number, message: string): number | string {
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : message;
}

type OptionHandler = (next: () => string | undefined, options: Options) => string | undefined;

const OPTION_HANDLERS: Readonly<Record<string, OptionHandler>> = {
  "--list": (_next, options) => { options.list = true; return undefined; },
  "--heap": (next, options) => {
    const parsed = parseIntFlag(next(), 512, 65536, "--heap needs a whole number of megabytes (512..65536)");
    if (typeof parsed === "string") return parsed;
    options.heapMb = parsed;
    return undefined;
  },
  "--jobs": (next, options) => {
    const parsed = parseIntFlag(next(), 1, 8, "--jobs needs a whole number from 1 to 8");
    if (typeof parsed === "string") return parsed;
    options.jobs = parsed;
    return undefined;
  },
  "--timeout": (next, options) => {
    const parsed = parseIntFlag(next(), 1, 3600, "--timeout needs a whole number of seconds (1..3600)");
    if (typeof parsed === "string") return parsed;
    options.timeoutSeconds = parsed;
    return undefined;
  },
  "--only": (next, options) => {
    const value = next();
    if (value === undefined || value === "") return "--only needs a comma-separated list of shard names";
    options.only = new Set(value.split(","));
    return undefined;
  },
  "--tsc-bin": (next, options) => {
    const value = next();
    if (value === undefined || value === "") return "--tsc-bin needs a path";
    options.tscBin = value;
    return undefined;
  },
};

export function parseOptions(argv: readonly string[]): Options | string {
  const options: Options = { list: false, heapMb: DEFAULT_HEAP_MB };
  const usage = "Usage: node scripts/typecheck-shards.ts [--list] [--only <shard>[,<shard>...]] [--jobs <n>] [--heap <MB>] [--timeout <seconds>]";
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const handler = OPTION_HANDLERS[arg];
    if (handler === undefined) return `Unknown option ${arg}. ${usage}`;
    const error = handler(() => argv[++index], options);
    if (error !== undefined) return error;
  }
  return options;
}

export function exitCodeFor(results: readonly ShardResult[]): 0 | 1 {
  return results.length > 0 && results.every((result) => result.verdict.ok) ? 0 : 1;
}

/** Runs every shard with bounded concurrency and returns results in the original shard order. */
export async function runShards(
  shards: readonly Shard[],
  jobs: number,
  run: (shard: Shard) => Promise<ShardResult>,
  report: (result: ShardResult) => void = () => undefined,
): Promise<ShardResult[]> {
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

const require = createRequire(import.meta.url);

function parseConfigFiles(ts: typeof TypeScript, configPath: string, root: string): { ok: true; files: string[] } | { ok: false; reason: string } {
  const unrecoverable: string[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => { unrecoverable.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); },
  });
  const errors = [...unrecoverable, ...(parsed?.errors ?? []).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))];
  if (parsed === undefined || errors.length > 0) return { ok: false, reason: `${configPath}: ${errors.join("\n") || "could not be parsed"}` };
  if (parsed.options.noCheck === true) return { ok: false, reason: `${configPath} sets noCheck, so it would report no errors at all` };
  return { ok: true, files: parsed.fileNames.map((file) => relative(root, file).replaceAll("\\", "/")) };
}

/** Proves every file in tsconfig.lint.json is checked by either tsconfig.json's package projects or one of these shards. */
export function verifyCoverage(root: string, shards: readonly Shard[], projectPaths: ReadonlyMap<string, string>): { ok: true } | { ok: false; reason: string } {
  const ts = require("typescript") as typeof TypeScript;
  const lint = parseConfigFiles(ts, join(root, LINT_CONFIG), root);
  if (!lint.ok) return lint;
  const covered = new Set<string>();
  for (const refDir of rootReferences(root)) {
    const pkg = parseConfigFiles(ts, join(refDir, "tsconfig.json"), root);
    if (!pkg.ok) return pkg;
    pkg.files.forEach((file) => covered.add(file));
  }
  for (const shard of shards) {
    const cfg = projectPaths.get(shard.name);
    if (cfg === undefined) return { ok: false, reason: `Missing generated tsconfig for shard ${shard.name}` };
    const parsed = parseConfigFiles(ts, cfg, root);
    if (!parsed.ok) return parsed;
    parsed.files.forEach((file) => covered.add(file));
  }
  const missing = lint.files.filter((file) => !covered.has(file)).sort();
  if (missing.length > 0) return { ok: false, reason: `Files in ${LINT_CONFIG} not covered by any typecheck project:\n  ${missing.slice(0, 20).join("\n  ")}` };
  return { ok: true };
}

function runTscShard(root: string, tscBin: string, heapMb: number, timeoutSeconds: number, shard: Shard, projectPath: string): Promise<ShardResult> {
  const started = Date.now();
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, tscArguments(tscBin, projectPath, heapMb), { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutSeconds * 1000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const finish = (run: TscRun): void => {
      clearTimeout(timer);
      done({ ...run, shard, seconds: (Date.now() - started) / 1000, verdict: interpretTscRun(run) });
    };
    child.on("error", (error) => { finish({ status: null, signal: null, stdout, stderr, error: String(error) }); });
    child.on("close", (status, signal) => {
      finish(timedOut ? { status, signal, stdout, stderr, error: `timed out after ${timeoutSeconds}s (--timeout)` } : { status, signal, stdout, stderr });
    });
  });
}

function describeResult(result: ShardResult): string {
  const header = `${result.verdict.ok ? "ok  " : "FAIL"} ${result.shard.name} (${result.seconds.toFixed(1)}s)`;
  if (result.verdict.ok) return header;
  const hint = result.stdout.includes("error TS2307")
    ? "\nSome errors are missing-module errors (TS2307). Run `npm run typecheck` first: shards read the packages' built declarations."
    : "";
  return `${header}\n${result.verdict.reason}${hint}`;
}

export function githubAnnotations(results: readonly ShardResult[]): string[] {
  return results.flatMap((result) => (result.verdict.ok
    ? []
    : [`::error title=Typecheck shard ${result.shard.name} failed::${result.verdict.reason.split("\n")[0] ?? "typecheck failed"}`]));
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (typeof options === "string") { console.error(options); process.exitCode = 2; return; }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const all = planShards();
  const unknown = [...(options.only ?? [])].filter((name) => !all.some((shard) => shard.name === name));
  if (unknown.length > 0) { console.error(`No such shard: ${unknown.join(", ")}. Shards: ${all.map((shard) => shard.name).join(", ")}`); process.exitCode = 2; return; }
  const selected = all.filter((shard) => options.only === undefined || options.only.has(shard.name));
  if (options.list) { console.log(selected.map((shard) => `${shard.name}: ${shard.include.length} include pattern(s)`).join("\n")); return; }

  const references = rootReferences(root);
  const projectPaths = new Map(all.map((shard) => [shard.name, writeShardTsconfig(shard, root, references)]));
  if (options.only === undefined) {
    const coverage = verifyCoverage(root, all, projectPaths);
    if (!coverage.ok) { console.error(coverage.reason); process.exitCode = 1; return; }
  }

  const jobs = options.jobs ?? defaultJobs(totalmem(), availableParallelism());
  const tscBin = options.tscBin ?? require.resolve("typescript/bin/tsc");
  const started = Date.now();
  const results = await runShards(
    selected,
    jobs,
    (shard) => runTscShard(root, tscBin, options.heapMb, options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, shard, projectPaths.get(shard.name)!),
    (result) => { console.log(describeResult(result)); },
  );
  if (process.env.GITHUB_ACTIONS === "true") for (const line of githubAnnotations(results)) console.log(line);
  const failed = results.filter((result) => !result.verdict.ok);
  console.log(`${results.length - failed.length} of ${results.length} typecheck shards passed in ${((Date.now() - started) / 1000).toFixed(1)}s (${jobs} at a time).`);
  if (failed.length > 0) console.error(`Failed: ${failed.map((result) => result.shard.name).join(", ")}`);
  process.exitCode = exitCodeFor(results);
}

// Usage: node scripts/typecheck-shards.ts [options], from the repository root, after tsc -b
if (process.argv[1]?.endsWith("typecheck-shards.ts")) await main();
