import "./mutation-spot-offline.js";
import { execFileSync } from "node:child_process";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { setCandidateWriteHookForTests } from "../../packages/worker/src/candidate-fs.js";
import { createMutationCopy, snapshotCandidate } from "../../packages/worker/src/verification/mutation-restore.js";
import { runMutationSpotCheck, type MutationSpotOptions } from "../../packages/worker/src/verification/mutation-spot-check.js";
import { fixture, report } from "./mutation-spot-support.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); }, 60_000);
async function setup() { const f = await fixture(); roots.push(f.root); return f; }
const ok = { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
type Body = (directory: string, signal: AbortSignal) => Promise<typeof ok>;
async function run(f: Awaited<ReturnType<typeof fixture>>, body: Body, extra: Partial<MutationSpotOptions> = {}) {
  return runMutationSpotCheck({ repositories: [f.repository], selection: f.selection, seed: "seed", scratchRoot: f.scratchRoot,
    runners: (directory) => ({ runProjectCommand: (_command, signal) => body(directory, signal), runAgentCommand: async () => { throw new Error("no agent"); } }), ...extra });
}

it("does not count a runner that ignores source and fails after its first pass", async () => {
  const f = await setup(); let calls = 0;
  const result = await run(f, async (directory) => {
    calls += 1; await writeFile(join(directory, "report.json"), report(calls === 1 ? "passed" : "failed"));
    return { ...ok, exitCode: calls === 1 ? 0 : 1 };
  });
  expect(result).toMatchObject({ caught: 0, counted: 0, mutants: [{ outcome: "invalid" }] });
  expect(calls).toBe(3);
});
it.each(["failed", "missing", "wrong_identity", "nonzero", "duplicate", "skipped"])("requires a clean complete pristine recheck: %s", async (kind) => {
  const f = await setup(); let calls = 0; const copies = new Set<string>();
  const result = await run(f, async (directory) => {
    calls += 1; copies.add(directory);
    if (calls === 3) {
      expect(await readFile(join(directory, "value.ts"), "utf8")).toBe("export const value = true;\n");
      if (kind !== "missing") await writeFile(join(directory, "report.json"), kind === "duplicate"
        ? JSON.stringify({ testResults: [{ name: "test.ts", assertionResults: [{ fullName: "test", status: "passed" }, { fullName: "test", status: "passed" }] }] })
        : report(kind === "failed" ? "failed" : kind === "skipped" ? "skipped" : "passed").replace('"test"', kind === "wrong_identity" ? '"other"' : '"test"'));
      return { ...ok, exitCode: kind === "nonzero" ? 1 : 0 };
    }
    await writeFile(join(directory, "report.json"), report(calls === 1 ? "passed" : "failed"));
    return { ...ok, exitCode: calls === 1 ? 0 : 1 };
  });
  expect(result).toMatchObject({ caught: 0, counted: 0, mutants: [{ outcome: "invalid" }] });
  expect(copies.size).toBe(3); expect(await readdir(f.scratchRoot)).toEqual([]);
});
it("counts a source-dependent failure only after a second independent pristine pass", async () => {
  const f = await setup(); const sources: string[] = [];
  const result = await run(f, async (directory) => {
    const text = await readFile(join(directory, "value.ts"), "utf8"); sources.push(text);
    const passed = text.includes("= true"); await writeFile(join(directory, "report.json"), report(passed ? "passed" : "failed"));
    return { ...ok, exitCode: passed ? 0 : 1 };
  });
  expect(result).toMatchObject({ caught: 1, counted: 1 });
  expect(sources).toEqual(["export const value = true;\n", "export const value = false;\n", "export const value = true;\n"]);
});
it("awaits the aborted runner settlement before returning an untrusted timeout", async () => {
  const f = await setup(); let settled = false; let aborted = false; let bypassedJoin = false;
  let pending: Promise<void> = Promise.resolve();
  try {
    const result = await run(f, async (_directory, signal) => {
      pending = new Promise<void>((resolve) => signal.addEventListener("abort", () => {
        aborted = true; setTimeout(resolve, 1_000);
      }, { once: true }));
      await pending; settled = true; return { ...ok, timedOut: true };
    }, { limits: { perMutantTimeMs: 20, totalTimeMs: 10_000 }, clock: () => {
      if (aborted && !settled) bypassedJoin = true;
      return performance.now();
    } });
    expect(bypassedJoin).toBe(false); expect(settled).toBe(true);
    expect(result).toMatchObject({ trustedAfter: false, counted: 0 });
  } finally { await pending; }
});

it.each(["named", "subclass"])("propagates RunnerKillUnconfirmedError (%s) and retains the copy for quarantine", async (kind) => {
  class RunnerKillUnconfirmedError extends Error {}
  const f = await setup(); const error = kind === "subclass" ? new RunnerKillUnconfirmedError("fixed fixture message") : new Error("fixed fixture message");
  if (kind === "named") error.name = "RunnerKillUnconfirmedError";
  let directory = "";
  await expect(run(f, async (copy, signal) => {
    directory = copy;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => setTimeout(resolve, 20), { once: true }));
    throw error;
  }, { limits: { perMutantTimeMs: 20, totalTimeMs: 10_000 } })).rejects.toBe(error);
  expect((await lstat(directory)).isDirectory()).toBe(true);
});

it("copies a real Python venv with an absolute interpreter into independent files", async () => {
  const f = await setup(); await writeFile(join(f.directory, ".gitignore"), ".venv/\n");
  execFileSync("python3", ["-m", "venv", "--without-pip", ".venv"], { cwd: f.directory, stdio: "pipe" });
  const before = await snapshotCandidate(f.directory);
  const interpreter = await realpath(join(f.directory, ".venv/bin/python3"));
  const original = await readFile(interpreter);
  const copy = await createMutationCopy(f.directory, f.scratchRoot);
  const copiedInterpreter = await realpath(join(copy.directory, ".venv/bin/python3"));
  expect(copiedInterpreter.startsWith(copy.directory + "/")).toBe(true);
  const a = await lstat(interpreter); const b = await lstat(copiedInterpreter);
  expect([a.dev, a.ino]).not.toEqual([b.dev, b.ino]); expect(b.nlink).toBe(1);
  expect(execFileSync(join(copy.directory, ".venv/bin/python3"), ["-c", "import sys; print(sys.prefix)"], { encoding: "utf8" }).trim()).toBe(join(copy.directory, ".venv"));
  await writeFile(copiedInterpreter, "private overwrite");
  expect(await readFile(interpreter)).toEqual(original); expect(await snapshotCandidate(f.directory)).toEqual(before);
});
it("copies a real offline npm install beyond 20k dependency entries without spending the source cap", async () => {
  const f = await setup(); await writeFile(join(f.directory, ".gitignore"), "node_modules/\n");
  const pkg = join(f.root, "package"); await mkdir(pkg);
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "b11-local-fixture", version: "1.0.0", main: "index.js", bin: { "b11-local-fixture": "cli.js" } }));
  await writeFile(join(pkg, "index.js"), "module.exports = 42;\n"); await writeFile(join(pkg, "cli.js"), "#!/usr/bin/env node\nconsole.log(42);\n");
  const env = { ...process.env, npm_config_cache: join(f.root, "npm-cache"), npm_config_offline: "true", npm_config_update_notifier: "false" };
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", f.root], { cwd: pkg, env, stdio: "pipe" });
  execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--no-save", join(f.root, "b11-local-fixture-1.0.0.tgz")], { cwd: f.directory, env, stdio: "pipe" });
  const moduleDir = join(f.directory, "node_modules/b11-local-fixture");
  for (let i = 0; i < 20_001; i += 1) await symlink("index.js", join(moduleDir, `entry-${i}`));
  const copy = await createMutationCopy(f.directory, f.scratchRoot);
  expect(execFileSync(process.execPath, ["-e", "console.log(require('b11-local-fixture'))"], { cwd: copy.directory, encoding: "utf8" }).trim()).toBe("42");
  expect(await realpath(join(copy.directory, "node_modules/.bin/b11-local-fixture"))).toBe(join(copy.directory, "node_modules/b11-local-fixture/cli.js"));
  await writeFile(join(copy.directory, "node_modules/b11-local-fixture/index.js"), "private overwrite");
  expect(await readFile(join(moduleDir, "index.js"), "utf8")).toBe("module.exports = 42;\n");
}, 60_000);
it("copies pnpm-style ignored hard links without sharing store or candidate inodes", async () => {
  const f = await setup(); await writeFile(join(f.directory, ".gitignore"), "node_modules/\n");
  const store = join(f.root, "store.js"); await writeFile(store, "module.exports = 42;\n");
  const path = "node_modules/.pnpm/pkg@1/node_modules/pkg/index.js";
  await mkdir(join(f.directory, "node_modules/.pnpm/pkg@1/node_modules/pkg"), { recursive: true });
  await link(store, join(f.directory, path)); await symlink(".pnpm/pkg@1/node_modules/pkg", join(f.directory, "node_modules/pkg"));
  const copy = await createMutationCopy(f.directory, f.scratchRoot);
  expect((await lstat(join(copy.directory, path))).nlink).toBe(1);
  expect(execFileSync(process.execPath, ["-e", "console.log(require('pkg'))"], { cwd: copy.directory, encoding: "utf8" }).trim()).toBe("42");
  await writeFile(join(copy.directory, path), "private overwrite");
  expect(await readFile(store, "utf8")).toBe("module.exports = 42;\n");
});
it.each(["not_ignored", "tracked", "candidate_link", "external_directory", "relative_escape", "unignored_interpreter", "arbitrary_external", "unnamed_folder"])("dependency exceptions still refuse %s", async (kind) => {
  const f = await setup(); await mkdir(join(f.directory, ".venv/bin"), { recursive: true });
  if (kind === "unnamed_folder") await mkdir(join(f.directory, ".cache/bin"), { recursive: true });
  if (kind !== "not_ignored" && kind !== "unignored_interpreter") await writeFile(join(f.directory, ".gitignore"), ".venv/\n.cache/\n");
  const sentinel = join(f.root, "sentinel"); await writeFile(sentinel, "sentinel");
  if (kind === "relative_escape") await writeFile(join(f.scratchRoot, "sentinel"), "sentinel");
  const path = join(f.directory, kind === "arbitrary_external" ? ".venv/bin/other" : kind === "unnamed_folder" ? ".cache/bin/python3" : ".venv/bin/python3");
  if (kind === "not_ignored" || kind === "tracked" || kind === "unnamed_folder") {
    await link(sentinel, path);
    if (kind === "tracked") f.git("add", "--force", ".venv/bin/python3");
  } else await symlink(kind === "candidate_link" ? join(f.directory, "value.ts") : kind === "external_directory" ? f.root : kind === "unignored_interpreter" || kind === "arbitrary_external" ? sentinel : "../../../sentinel", path);
  await expect(createMutationCopy(f.directory, f.scratchRoot)).rejects.toThrow();
  expect(await readdir(f.scratchRoot)).toEqual(kind === "relative_escape" ? ["sentinel"] : []); expect(await readFile(sentinel, "utf8")).toBe("sentinel");
});

it("enforces the separate dependency byte cap and cleans partial copies", async () => {
  const f = await setup(); await writeFile(join(f.directory, ".gitignore"), "node_modules/\n");
  await mkdir(join(f.directory, "node_modules"));
  for (let i = 0; i < 17; i += 1) {
    const handle = await open(join(f.directory, "node_modules", `file-${i}`), "wx");
    try { await handle.truncate(32 * 1024 * 1024); } finally { await handle.close(); }
  }
  await expect(createMutationCopy(f.directory, f.scratchRoot)).rejects.toThrow();
  expect(await readdir(f.scratchRoot)).toEqual([]);
}, 60_000);
it("accepts the dependency entry limit then refuses the next entry", async () => {
  const f = await setup(); await writeFile(join(f.directory, ".gitignore"), "node_modules/\n");
  await mkdir(join(f.directory, "node_modules"));
  // One dependency directory plus 99,999 non-traversed aliases = exactly 100,000 entries.
  for (let i = 0; i < 99_999; i += 1) await symlink("../value.ts", join(f.directory, "node_modules", `entry-${i}`));
  const copy = await createMutationCopy(f.directory, f.scratchRoot);
  expect((await readdir(join(copy.directory, "node_modules"))).length).toBe(99_999);
  await rm(copy.directory, { recursive: true, force: true });
  await symlink("../value.ts", join(f.directory, "node_modules", "overflow"));
  await expect(createMutationCopy(f.directory, f.scratchRoot)).rejects.toThrow();
  expect(await readdir(f.scratchRoot)).toEqual([]);
}, 120_000);

it("excludes a caught mutant when its pristine recheck times out", async () => {
  const f = await setup(); let calls = 0;
  const result = await run(f, async (directory) => {
    calls += 1;
    await writeFile(join(directory, "report.json"), report(calls === 2 ? "failed" : "passed"));
    return { ...ok, exitCode: calls === 2 ? 1 : 0, timedOut: calls === 3 };
  });
  expect(result).toMatchObject({ trustedAfter: false, caught: 0, counted: 0, mutants: [{ outcome: "timed_out" }] });
});

it("deletes copies when mutation writing fails before a runner starts", async () => {
  const f = await setup(); const before = await snapshotCandidate(f.directory);
  await writeFile(join(f.directory, ".env"), "FIXTURE=yes\n");
  let calls = 0;
  setCandidateWriteHookForTests(async (step) => { if (step === "mutation write") throw new Error("fixture write failure"); });
  try {
    const result = await run(f, async (directory) => { calls += 1; await writeFile(join(directory, "report.json"), report("passed")); return ok; });
    expect(result).toMatchObject({ reason: "unreadable", trustedAfter: true, counted: 0 });
    expect(calls).toBe(1); expect(await readdir(f.scratchRoot)).toEqual([]);
    expect(await snapshotCandidate(f.directory)).toEqual(before);
  } finally { setCandidateWriteHookForTests(undefined); }
});
