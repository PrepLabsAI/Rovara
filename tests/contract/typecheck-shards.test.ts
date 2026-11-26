import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  DEFAULT_HEAP_MB,
  REST,
  SHARD_GROUPS,
  defaultJobs,
  exitCodeFor,
  githubAnnotations,
  interpretTscRun,
  parseOptions,
  planShards,
  rootReferences,
  runShards,
  shardTsconfig,
  tscArguments,
  verifyCoverage,
  writeShardTsconfig,
  type ShardResult,
  type TscRun,
} from "../../scripts/typecheck-shards.js";

describe("interpreting a tsc shard run", () => {
  const ok: TscRun = { status: 0, signal: null, stdout: "", stderr: "" };

  it("accepts exit 0 with empty stdout and stderr", () => {
    expect(interpretTscRun(ok)).toEqual({ ok: true });
  });

  it("fails exit 0 if stdout or stderr is non-empty", () => {
    expect(interpretTscRun({ ...ok, stdout: "unexpected\n" }).ok).toBe(false);
    expect(interpretTscRun({ ...ok, stderr: "warning\n" }).ok).toBe(false);
  });

  it("reports located errors on non-zero exit", () => {
    const verdict = interpretTscRun({ ...ok, status: 2, stdout: "tests/unit/a.test.ts(1,1): error TS2322: Bad.\n" });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("TS2322");
  });

  it("fails non-zero exit with empty output instead of passing silently", () => {
    const verdict = interpretTscRun({ ...ok, status: 1 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("exited with code 1");
  });

  it("hints about memory on SIGABRT and names other signals or spawn errors", () => {
    const abrt = interpretTscRun({ ...ok, status: null, signal: "SIGABRT" });
    expect(abrt.ok).toBe(false);
    if (!abrt.ok) expect(abrt.reason).toMatch(/SIGABRT.*out of memory/);

    const kill = interpretTscRun({ ...ok, status: null, signal: "SIGKILL" });
    expect(kill.ok).toBe(false);
    if (!kill.ok) expect(kill.reason).toContain("SIGKILL");

    const err = interpretTscRun({ ...ok, status: null, error: "spawn ENOENT" });
    expect(err.ok).toBe(false);
    if (!err.ok) expect(err.reason).toContain("spawn ENOENT");
  });
});

describe("typecheck shard planning and options", () => {
  it("plans named shards plus the catch-all rest shard, covering every letter of tests/unit and tests/contract", () => {
    const shards = planShards();
    expect(shards.at(-1)?.name).toBe(REST);
    expect(shards).toHaveLength(SHARD_GROUPS.length + 1);
    const unitIncludes = shards.filter((s) => s.name.startsWith("unit-")).flatMap((s) => s.include);
    const contractIncludes = shards.filter((s) => s.name.startsWith("contract-")).flatMap((s) => s.include);
    for (const letter of "abcdefghijklmnopqrstuvwxyz") {
      expect(unitIncludes, `tests/unit/${letter}*.ts`).toContain(`tests/unit/${letter}*.ts`);
      expect(contractIncludes, `tests/contract/${letter}*.ts`).toContain(`tests/contract/${letter}*.ts`);
    }
  });

  it("generates incremental --noEmit shard tsconfigs referencing every root solution project", () => {
    const root = resolve(".");
    const refs = rootReferences(root);
    expect(refs.length).toBeGreaterThanOrEqual(14);
    const cfg = shardTsconfig(planShards()[0]!, root, refs) as {
      compilerOptions: { composite: boolean; declaration: boolean; incremental: boolean; noEmit: boolean; disableSourceOfProjectReferenceRedirect: boolean; tsBuildInfoFile: string };
      references: Array<{ path: string }>;
    };
    expect(cfg.compilerOptions.composite).toBe(false);
    expect(cfg.compilerOptions.declaration).toBe(false);
    expect(cfg.compilerOptions.incremental).toBe(true);
    expect(cfg.compilerOptions.noEmit).toBe(true);
    expect(cfg.compilerOptions.disableSourceOfProjectReferenceRedirect).toBe(true);
    expect(cfg.compilerOptions.tsBuildInfoFile).toBe("./unit-a-k.tsbuildinfo");
    expect(cfg.references.map((r) => r.path)).toEqual(refs);
  });

  it("covers 100% of files in tsconfig.lint.json when combined with tsconfig.json references", () => {
    const root = resolve(".");
    const shards = planShards();
    const refs = rootReferences(root);
    const paths = new Map(shards.map((shard) => [shard.name, writeShardTsconfig(shard, root, refs)]));
    expect(verifyCoverage(root, shards, paths)).toEqual({ ok: true });
  });

  it("picks 2 concurrent shards on a 16 GB / 4-core machine and 1 on smaller machines", () => {
    expect(defaultJobs(16 * 1024 ** 3, 4)).toBe(2);
    expect(defaultJobs(8 * 1024 ** 3, 4)).toBe(1);
    expect(defaultJobs(16 * 1024 ** 3, 2)).toBe(1);
  });

  it("builds tsc arguments with a 4 GB per-shard heap by default", () => {
    expect(tscArguments("/repo/node_modules/typescript/bin/tsc", "/repo/shard.json")).toEqual([
      `--max-old-space-size=${DEFAULT_HEAP_MB}`,
      "/repo/node_modules/typescript/bin/tsc",
      "-p",
      "/repo/shard.json",
      "--pretty",
      "false",
    ]);
  });

  it("parses CLI flags and rejects invalid ones", () => {
    expect(parseOptions(["--list", "--jobs", "2", "--heap", "2048", "--timeout", "120", "--only", "rest,unit-a-k"])).toEqual({
      list: true,
      heapMb: 2048,
      timeoutSeconds: 120,
      jobs: 2,
      only: new Set(["rest", "unit-a-k"]),
    });
    expect(typeof parseOptions(["--jobs", "0"])).toBe("string");
    expect(typeof parseOptions(["--heap", "100"])).toBe("string");
    expect(typeof parseOptions(["--unknown"])).toBe("string");
  });

  it("runs shards in bounded parallel and preserves result order, exit code, and GitHub annotations", async () => {
    const shards = planShards().slice(0, 3);
    const results = await runShards(shards, 2, async (shard): Promise<ShardResult> => ({
      shard,
      status: shard.name === shards[1]!.name ? 2 : 0,
      signal: null,
      stdout: shard.name === shards[1]!.name ? "bad.ts(1,1): error TS2322: nope\n" : "",
      stderr: "",
      seconds: 0.1,
      verdict: shard.name === shards[1]!.name ? { ok: false, reason: "bad.ts(1,1): error TS2322: nope" } : { ok: true },
    }));
    expect(results.map((r) => r.shard.name)).toEqual(shards.map((s) => s.name));
    expect(exitCodeFor(results)).toBe(1);
    expect(exitCodeFor(results.filter((r) => r.verdict.ok))).toBe(0);
    expect(githubAnnotations(results)).toEqual([
      `::error title=Typecheck shard ${shards[1]!.name} failed::bad.ts(1,1): error TS2322: nope`,
    ]);
  });
});

interface Step { name?: string; if?: string; run?: string; uses?: string; with?: { path?: string; key?: string; "restore-keys"?: string } }
interface Workflow { jobs: Record<string, { if?: string; steps: Step[] }> }

describe("wiring", () => {
  it("runs tsc -b then the parallel incremental shards in npm run typecheck:all", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["typecheck:all"]).toBe(`${pkg.scripts.typecheck!} && node scripts/typecheck-shards.ts`);
    expect(pkg.scripts["typecheck:baseline"]).toBeUndefined();
  });

  it("restores TypeScript build info cache before running typecheck:all in CI", async () => {
    const workflow = YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as Workflow;
    const job = workflow.jobs.typecheck!;
    const install = job.steps.findIndex((step) => step.run === "npm ci");
    const cache = job.steps.findIndex((step) => (step.uses ?? "").startsWith("actions/cache@"));
    const check = job.steps.findIndex((step) => step.run === "npm run typecheck:all");
    expect(cache).toBeGreaterThan(install);
    expect(check).toBe(cache + 1);
    expect(job.steps[cache]!.with?.path).toContain("node_modules/.cache/tsc-shards");
    expect(job.steps[cache]!.with?.path).toContain("packages/*/dist");
    expect(job.steps[cache]!.with?.path).toContain("infra/dist");
    expect(job.if).toBe("needs.plan.outputs.docs_only != 'true' && needs.plan.outputs.mode != 'reuse'");
    expect(job.steps[check]!.if).toBeUndefined();
  });

  it("keeps typecheck:all in the release workflow", async () => {
    const workflow = YAML.parse(await readFile(".github/workflows/release.yml", "utf8")) as Workflow;
    const runs = workflow.jobs.typecheck!.steps.map((step) => step.run ?? "").join("\n");
    expect(runs).toContain("npm run typecheck && npm run typecheck:all");
  });
});
