import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import type * as TypeScript from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_HEAP_MB,
  PROJECT_ENV,
  REST,
  SHARD_DIRECTORIES,
  defaultJobs,
  eslintArguments,
  exitCodeFor,
  parseOptions,
  planShards,
  runShards,
  shardTsconfig,
  writeShardTsconfig,
  type Shard,
  type ShardResult,
} from "../../scripts/lint-shards.js";

// `eslint .` with the type-aware rules keeps one TypeScript program over the whole repository, and every file's lint state, in one heap.
// `npm run lint` lints in shards instead (scripts/lint-shards.ts). These tests keep the shards covering exactly what `eslint .` covers,
// with the same config, and keep a failing shard failing the command.
const root = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof TypeScript;
const shards = planShards();
const scratch = mkdtempSync(join(tmpdir(), "lint-shards-test-"));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

/**
 * The files ESLint itself would lint for these command-line arguments: its own enumeration (config `files` patterns and `ignores`, read
 * from eslint.config.js), through the same API the command line uses. Type information is switched off, so this only parses; which files
 * are enumerated does not depend on it.
 */
async function lintedBy(targets: readonly string[], ignorePatterns: readonly string[] = []): Promise<string[]> {
  const eslint = new ESLint({ cwd: root, errorOnUnmatchedPattern: false, ignorePatterns: [...ignorePatterns], overrideConfig: [tseslint.configs.disableTypeChecked] });
  const results = await eslint.lintFiles([...targets]);
  return results.map((result) => relative(root, result.filePath).replaceAll("\\", "/")).sort();
}

let wholeRepository: string[] = [];
const perShard = new Map<string, string[]>();
beforeAll(async () => {
  wholeRepository = await lintedBy(["."]);
  for (const shard of shards) perShard.set(shard.name, await lintedBy(shard.targets, shard.ignore));
}, 280_000);

describe("the lint shards: which files they lint", () => {
  it("lint, together, exactly the files that `eslint .` lints, each file in exactly one shard", () => {
    expect(wholeRepository.length).toBeGreaterThan(1000); // positive control: the enumeration found the repository
    const owners = new Map<string, string[]>();
    for (const [name, files] of perShard) for (const file of files) owners.set(file, [...(owners.get(file) ?? []), name]);
    expect([...owners.keys()].sort()).toEqual(wholeRepository);
    expect([...owners].filter(([, names]) => names.length > 1).map(([file, names]) => `${file}: ${names.join(", ")}`)).toEqual([]);
  });

  it("have no empty shard, and the last shard is the catch-all that picks up what no directory shard names", () => {
    for (const shard of shards) expect(perShard.get(shard.name)?.length, shard.name).toBeGreaterThan(0);
    expect(shards.at(-1)?.name).toBe(REST);
    expect(shards.at(-1)?.targets).toEqual(["."]);
    // vitest.config.ts is in no directory shard: only the catch-all can have it.
    expect(perShard.get(REST)).toContain("vitest.config.ts");
    expect(new Set(shards.map((shard) => shard.name)).size).toBe(shards.length);
  });

  it("respect the ignores of eslint.config.js: an ignored fixture is in no shard", () => {
    const ignoredFixture = "tests/fixtures/e2e-web-api-app/server.mjs";
    expect(wholeRepository).not.toContain(ignoredFixture);
    for (const files of perShard.values()) expect(files).not.toContain(ignoredFixture);
    for (const files of perShard.values()) expect(files.filter((file) => file.includes("/dist/") || file.includes("node_modules/"))).toEqual([]);
  });
});

describe("the lint shards: typed rules", () => {
  it("give every shard a TypeScript program (tsconfig) that contains every file the shard lints", () => {
    for (const shard of shards) {
      const file = writeShardTsconfig(shard, root);
      const errors: string[] = [];
      const parsed = ts.getParsedCommandLineOfConfigFile(file, {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => { errors.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); },
      });
      expect(errors, shard.name).toEqual([]);
      expect(parsed?.errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), shard.name).toEqual([]);
      const program = new Set((parsed?.fileNames ?? []).map((name) => relative(root, name).replaceAll("\\", "/")));
      const missing = (perShard.get(shard.name) ?? []).filter((linted) => !program.has(linted));
      expect(missing, `${shard.name}: files linted but not in the shard's program`).toEqual([]);
      // A shard's program is its own files, not the repository's: that is what keeps the heap small.
      expect(program.size, shard.name).toBeLessThan(wholeRepository.length);
    }
  });

  it("derive each program from tsconfig.lint.json, so the compiler options of the whole-repository program carry over unchanged", () => {
    for (const shard of shards) {
      const config = shardTsconfig(shard, root) as { extends: string; compilerOptions?: unknown; include: string[] };
      expect(config.extends, shard.name).toBe(resolve(root, "tsconfig.lint.json"));
      expect(config.compilerOptions, shard.name).toBeUndefined();
      expect(config.include.length, shard.name).toBeGreaterThan(0);
    }
    const parsedWhole = ts.getParsedCommandLineOfConfigFile(resolve(root, "tsconfig.lint.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
    const parsedShard = ts.getParsedCommandLineOfConfigFile(writeShardTsconfig(shards[0]!, root), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
    expect(parsedShard?.options.strict).toBe(true);
    expect({ ...parsedShard?.options, configFilePath: undefined }).toEqual({ ...parsedWhole?.options, configFilePath: undefined });
  });

  it("hand the shard's program to eslint.config.js through the environment, and fall back to tsconfig.lint.json when it is not set", () => {
    const config = readFileSync(join(root, "eslint.config.js"), "utf8");
    expect(config).toContain(`process.env.${PROJECT_ENV} || "./tsconfig.lint.json"`);
    expect(config).not.toMatch(/project:\s*"/); // no second, hard-coded project
    const script = 'const c=(await import("./eslint.config.js")).default; process.stdout.write(JSON.stringify(c.map(b=>b.languageOptions?.parserOptions?.project).filter(Boolean)))';
    const projects = (env: Record<string, string>): unknown => {
      const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== PROJECT_ENV));
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8", env: { ...base, ...env } });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    expect(projects({})).toEqual(["./tsconfig.lint.json"]);
    expect(projects({ [PROJECT_ENV]: "" })).toEqual(["./tsconfig.lint.json"]);
    expect(projects({ [PROJECT_ENV]: "/somewhere/shard.json" })).toEqual(["/somewhere/shard.json"]);
  });
});

describe("the lint shards: one config, one command", () => {
  it("pass eslint only the heap cap, the targets and ignore patterns: no rule, config or plugin override on the command line", () => {
    for (const shard of shards) {
      const args = eslintArguments("node_modules/eslint/bin/eslint.js", shard, DEFAULT_HEAP_MB);
      expect(args.slice(0, 2)).toEqual([`--max-old-space-size=${DEFAULT_HEAP_MB}`, "node_modules/eslint/bin/eslint.js"]);
      const flags = args.slice(2).filter((arg) => arg.startsWith("-"));
      expect(flags.every((flag) => flag === "--ignore-pattern" || flag === "--no-error-on-unmatched-pattern"), `${shard.name}: ${flags.join(" ")}`).toBe(true);
      expect(args.slice(-shard.targets.length)).toEqual([...shard.targets]);
    }
  });

  it("keep the heap cap per shard well under the 8 GB of heap one process over the repository needed", () => {
    expect(DEFAULT_HEAP_MB).toBeLessThanOrEqual(4096);
    expect(DEFAULT_HEAP_MB).toBeGreaterThanOrEqual(1024);
  });

  it("run through npm run lint, in CI, as one step", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts.lint).toBe("node scripts/lint-shards.ts");
    expect(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8").match(/^\s+- run: npm run lint$/gm)).toHaveLength(1);
  });

  it("read their options", () => {
    expect(parseOptions([])).toEqual({ list: false, heapMb: DEFAULT_HEAP_MB });
    expect(parseOptions(["--heap", "2048", "--jobs", "3", "--only", "a,b", "--eslint-bin", "x.js"])).toEqual({ list: false, heapMb: 2048, jobs: 3, only: new Set(["a", "b"]), eslintBin: "x.js" });
    expect(parseOptions(["--timeout", "30"])).toEqual({ list: false, heapMb: DEFAULT_HEAP_MB, timeoutSeconds: 30 });
    expect(parseOptions(["--timeout", "0"])).toMatch(/--timeout needs/);
    expect(parseOptions(["--list"])).toEqual({ list: true, heapMb: DEFAULT_HEAP_MB });
    expect(parseOptions(["--heap", "12"])).toMatch(/--heap needs/);
    expect(parseOptions(["--jobs", "0"])).toMatch(/--jobs needs/);
    expect(parseOptions(["--nope"])).toMatch(/Unknown option/);
  });

  it("choose a small bounded parallelism from the machine", () => {
    const gib = 1024 ** 3;
    expect(defaultJobs(16 * gib, 4)).toBe(2);
    expect(defaultJobs(8 * gib, 2)).toBe(1);
    expect(defaultJobs(64 * gib, 16)).toBe(2);
    expect(defaultJobs(16 * gib, 1)).toBe(1);
  });
});

describe("the lint shards: a failing shard fails the command", () => {
  const ok = (shard: Shard): ShardResult => ({ shard, status: 0, seconds: 0, output: "" });

  it("exits non-zero when any one shard fails, and still runs every other shard", async () => {
    const seen: string[] = [];
    const results = await runShards(shards, 2, async (shard) => {
      seen.push(shard.name);
      return shard.name === shards[3]!.name ? { ...ok(shard), status: 1 } : ok(shard);
    });
    expect(seen.sort()).toEqual(shards.map((shard) => shard.name).sort());
    expect(results.map((result) => result.shard.name)).toEqual(shards.map((shard) => shard.name));
    expect(exitCodeFor(results)).toBe(1);
    expect(exitCodeFor(shards.map(ok))).toBe(0);
  });

  it("counts a crash (a signal, or a process that could not start) as a failure", () => {
    expect(exitCodeFor([{ ...ok(shards[0]!), status: null, signal: "SIGABRT" }])).toBe(1);
    expect(exitCodeFor([{ ...ok(shards[0]!), status: null, error: "spawn ENOENT" }])).toBe(1);
    expect(exitCodeFor([])).toBe(1); // nothing ran: never reads as a pass
  });

  it("never runs more shards at once than the bound", async () => {
    let running = 0;
    let most = 0;
    await runShards(shards, 2, async (shard) => {
      running++;
      most = Math.max(most, running);
      await new Promise((done) => setTimeout(done, 5));
      running--;
      return ok(shard);
    });
    expect(most).toBe(2);
  });

  it("fails the real command when the eslint of one shard fails, and passes it when none does", () => {
    const fake = join(scratch, "fake-eslint.js");
    const log = join(scratch, "calls.log");
    writeFileSync(fake, [
      'const fs = require("node:fs");',
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), project: process.env.${PROJECT_ENV} }) + "\\n");`,
      'process.exit(process.argv.includes(process.env.FAKE_FAIL_ON ?? "\\u0000") ? 1 : 0);',
    ].join("\n"));
    chmodSync(fake, 0o755);
    const failOn = SHARD_DIRECTORIES[1]!.directories[0]!;
    const run = (env: Record<string, string>) => spawnSync(process.execPath, ["scripts/lint-shards.ts", "--eslint-bin", fake, "--jobs", "2"], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
    const failing = run({ FAKE_FAIL_ON: failOn });
    expect(failing.status, failing.stdout + failing.stderr).toBe(1);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv: string[]; project: string });
    expect(calls).toHaveLength(shards.length); // the other shards ran after the failure
    for (const call of calls) expect(call.project, "each shard is given a program").toMatch(/lint-shards[\\/].+\.json$/);
    expect(new Set(calls.map((call) => call.project)).size).toBe(shards.length); // one program per shard
    expect(failing.stdout).toContain("FAIL");
    rmSync(log);
    const passing = run({});
    expect(passing.status, passing.stdout + passing.stderr).toBe(0);
  });

  it("a shard whose glob matches no file lints nothing and passes, instead of failing eslint, in the real command and in the enumeration", async () => {
    const empty: Shard = { name: "empty", targets: ["tests/contract/zz-matches-nothing*.ts"], ignore: [], include: ["tests/contract/zz-matches-nothing*.ts"], exclude: [] };
    expect(await lintedBy(empty.targets)).toEqual([]);
    // Positive control: without the flag, eslint itself fails on this pattern, so the pass below is the flag's doing.
    const bare = spawnSync(process.execPath, ["node_modules/eslint/bin/eslint.js", ...empty.targets], { cwd: root, encoding: "utf8" });
    expect(bare.status).not.toBe(0);
    expect(bare.stderr).toContain("No files matching the pattern");
    const result = spawnSync(process.execPath, eslintArguments("node_modules/eslint/bin/eslint.js", empty, DEFAULT_HEAP_MB), { cwd: root, encoding: "utf8", env: { ...process.env, [PROJECT_ENV]: writeShardTsconfig(empty, root) } });
    expect(result.status, result.stderr).toBe(0);
  });

  it("stops a shard that runs longer than the timeout and fails the command with a clear message", () => {
    const fake = join(scratch, "slow-eslint.js");
    writeFileSync(fake, "setTimeout(() => process.exit(0), 60000);\n");
    const started = Date.now();
    const result = spawnSync(process.execPath, ["scripts/lint-shards.ts", "--eslint-bin", fake, "--only", shards[0]!.name, "--timeout", "1"], { cwd: root, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it("explains a shard killed by the operating system as a possible out-of-memory kill", () => {
    const fake = join(scratch, "killed-eslint.js");
    writeFileSync(fake, 'process.kill(process.pid, "SIGKILL");\n');
    const result = spawnSync(process.execPath, ["scripts/lint-shards.ts", "--eslint-bin", fake, "--only", shards[0]!.name], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("SIGKILL");
    expect(result.stdout).toContain("--jobs 1");
  });

  it("writes a shard's tsconfig in one piece (rename into place, no temporary file left)", () => {
    const file = writeShardTsconfig(shards[0]!, root);
    expect(JSON.parse(readFileSync(file, "utf8")) as unknown).toEqual(shardTsconfig(shards[0]!, root));
    expect(readdirSync(dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
