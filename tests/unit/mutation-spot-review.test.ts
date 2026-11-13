import "./mutation-spot-offline.js";
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { isolatedGitEnvironment } from "../../packages/worker/src/git.js";
import { runMutationSpotCheck, type MutationSpotOptions } from "../../packages/worker/src/verification/mutation-spot-check.js";
import { createMutationCopy } from "../../packages/worker/src/verification/mutation-restore.js";
import { fixture, report } from "./mutation-spot-support.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup(files?: Record<string, string>) { const f = await fixture(files); roots.push(f.root); return f; }
const ok = { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
type Body = (directory: string, command: Parameters<ReturnType<MutationSpotOptions["runners"]>["runProjectCommand"]>[0], signal: AbortSignal) => Promise<typeof ok>;
async function run(f: Awaited<ReturnType<typeof fixture>>, body: Body, extra: Partial<MutationSpotOptions> = {}) {
  return runMutationSpotCheck({ repositories: [f.repository], selection: f.selection, seed: "seed", scratchRoot: f.scratchRoot,
    runners: (directory) => ({ runProjectCommand: (command, signal) => body(directory, command, signal), runAgentCommand: async () => { throw new Error("no agent"); } }), ...extra });
}

it.each(["failed", "skipped", "missing", "nonzero", "flaky"])("refuses a %s control before any mutant", async (kind) => {
  const f = await setup(); let calls = 0;
  const result = await run(f, async (directory) => {
    calls += 1;
    if (kind !== "missing") await writeFile(join(directory, "report.json"), report(kind === "skipped" ? "skipped" : kind === "nonzero" ? "passed" : calls % 2 === 1 ? "failed" : "passed"));
    return { ...ok, exitCode: kind === "nonzero" ? 1 : 0 };
  });
  expect(result).toMatchObject({ reason: "baseline_failed", status: "not_run", trustedAfter: true, caught: 0, counted: 0, mutants: [] });
  expect(calls).toBe(1);
});
it("does not count a test requiring Git when the git-free control fails", async () => {
  const f = await setup(); let calls = 0;
  const result = await run(f, async (directory) => {
    calls += 1;
    let passed = true;
    try { execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, env: isolatedGitEnvironment(directory), stdio: "ignore" }); } catch { passed = false; }
    await writeFile(join(directory, "report.json"), report(passed ? "passed" : "failed"));
    return { ...ok, exitCode: passed ? 0 : 1 };
  });
  expect(result).toMatchObject({ reason: "baseline_failed", caught: 0, counted: 0 }); expect(calls).toBe(1);
});
it("requires every selected test in the control report", async () => {
  const f = await setup(); delete f.selection[0]!.coverageMap;
  f.selection[0]!.affectedTests = ["test.ts", "other1.ts"];
  expect(await run(f, async (directory) => { await writeFile(join(directory, "report.json"), report("passed")); return ok; })).toMatchObject({ reason: "baseline_failed", counted: 0 });
});
it("counts only a failure whose identity passed in the fresh pristine control", async () => {
  const f = await setup(); let calls = 0;
  const result = await run(f, async (directory) => {
    calls += 1;
    const text = await readFile(join(directory, "value.ts"), "utf8");
    await writeFile(join(directory, "report.json"), calls === 1 ? report("passed") : report("failed").replace('"test"', '"unrelated"'));
    expect(text).toBe(calls === 1 ? "export const value = true;\n" : "export const value = false;\n");
    return { ...ok, exitCode: calls === 1 ? 0 : 1 };
  });
  expect(result).toMatchObject({ caught: 0, counted: 0, mutants: [{ outcome: "invalid" }] }); expect(calls).toBe(2);
});
it.each(["symlink", "oversize", "hardlink", "entries"])("initial %s snapshot refusal leaves the untouched candidate trusted", async (kind) => {
  const f = await setup();
  if (kind === "oversize") { const handle = await open(join(f.directory, "value.ts"), "r+"); try { await handle.truncate(32 * 1024 * 1024 + 1); } finally { await handle.close(); } }
  if (kind === "symlink") { await rm(join(f.directory, "value.ts")); await symlink("missing", join(f.directory, "value.ts")); }
  if (kind === "hardlink") { const { link } = await import("node:fs/promises"); await link(join(f.directory, "value.ts"), join(f.root, "alias")); }
  if (kind === "entries") {
    const blob = f.git("rev-parse", "HEAD:value.ts");
    execFileSync("git", ["update-index", "--index-info"], { cwd: f.directory, env: isolatedGitEnvironment(f.directory), input: Array.from({ length: 20_001 }, (_, i) => `100644 ${blob}\tentry-${i}.ts\n`).join("") });
  }
  let calls = 0;
  expect(await run(f, async () => { calls += 1; return ok; })).toMatchObject({ reason: "unreadable", trustedAfter: true, counted: 0 }); expect(calls).toBe(0);
});
it("requires a caller-owned scratchRoot with no implicit temp directory", async () => {
  const f = await setup(); let calls = 0;
  const options: Omit<MutationSpotOptions, "scratchRoot"> = { repositories: [f.repository], selection: f.selection, seed: "seed", runners: () => ({ runProjectCommand: async () => { calls += 1; return ok; }, runAgentCommand: async () => { throw new Error("no agent"); } }) };
  // @ts-expect-error The required scratchRoot is also checked at runtime for untyped callers.
  expect(await runMutationSpotCheck(options)).toMatchObject({ reason: "unreadable", trustedAfter: true, counted: 0 }); expect(calls).toBe(0);
});
it("cleans settled copies including untracked environment files", async () => {
  const f = await setup(); const copies: string[] = [];
  await writeFile(join(f.directory, ".env"), "FIXTURE=yes\n");
  const result = await run(f, async (directory) => {
    copies.push(directory); expect(await readFile(join(directory, ".env"), "utf8")).toBe("FIXTURE=yes\n");
    await writeFile(join(directory, "report.json"), report(copies.length === 1 ? "passed" : "failed")); return { ...ok, exitCode: copies.length === 1 ? 0 : 1 };
  });
  expect(result.counted).toBe(1); expect(copies).toHaveLength(2);
  for (const directory of copies) await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(f.scratchRoot)).toEqual([]);
});
it("retains completed counts when the next mutant exhausts its work budget", async () => {
  const f = await setup({ "value.ts": "const a = true;\nconst b = false;\n" }); let now = 0; let calls = 0; let abandoned = "";
  const result = await run(f, async (directory, command) => {
    calls += 1;
    if (calls === 3) { expect(command.timeoutSeconds).toBe(10); now = 10_000; abandoned = directory; }
    await writeFile(join(directory, "report.json"), report(calls === 1 ? "passed" : "failed")); return { ...ok, exitCode: calls === 1 ? 0 : 1 };
  }, { clock: () => now, limits: { totalTimeMs: 20_000 } });
  expect(result).toMatchObject({ status: "completed", reason: "partial", trustedAfter: true, caught: 1, counted: 1, mutants: [{ outcome: "caught" }, { outcome: "timed_out" }] });
  expect((await lstat(abandoned)).isDirectory()).toBe(true);
});
it("copies internal dependency links without candidate aliases or Git metadata", async () => {
  const f = await setup();
  await mkdir(join(f.directory, "node_modules/.bin"), { recursive: true });
  await mkdir(join(f.directory, "packages/pkg"), { recursive: true });
  await writeFile(join(f.directory, "packages/pkg/cli.js"), "fixture");
  await symlink("../packages/pkg", join(f.directory, "node_modules/pkg"));
  await symlink("../pkg/cli.js", join(f.directory, "node_modules/.bin/pkg"));
  await mkdir(join(f.directory, ".venv/bin"), { recursive: true });
  await writeFile(join(f.directory, ".venv/bin/python3"), "fixture");
  await symlink("python3", join(f.directory, ".venv/bin/python"));
  const copy = await createMutationCopy(f.directory, f.scratchRoot);
  expect((await lstat(join(copy.directory, "node_modules/.bin/pkg"))).isSymbolicLink()).toBe(true);
  expect(await realpath(join(copy.directory, "node_modules/.bin/pkg"))).toBe(join(copy.directory, "packages/pkg/cli.js"));
  expect(await realpath(join(copy.directory, ".venv/bin/python"))).toBe(join(copy.directory, ".venv/bin/python3"));
  await expect(lstat(join(copy.directory, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["candidate", "outside", "chain", "relative"])("refuses a dependency link resolving to %s", async (kind) => {
  const f = await setup(); await mkdir(join(f.directory, "node_modules"));
  await writeFile(join(f.root, "outside"), "sentinel");
  await writeFile(join(f.scratchRoot, "outside"), "sentinel");
  await symlink(kind === "relative" ? "../../outside" : kind === "candidate" ? join(f.directory, "value.ts") : join(f.root, "outside"), join(f.directory, "node_modules/escape"));
  if (kind === "chain") await symlink("escape", join(f.directory, "node_modules/chain"));
  await expect(createMutationCopy(f.directory, f.scratchRoot)).rejects.toThrow();
  expect(await readdir(f.scratchRoot)).toEqual(["outside"]);
  expect(await readFile(join(f.scratchRoot, "outside"), "utf8")).toBe("sentinel");
});
it("createMutationCopy itself refuses a scratch parent inside the candidate", async () => {
  const f = await setup(); const before = await readdir(f.directory); let allocated = false;
  await expect(createMutationCopy(f.directory, f.directory, () => {
    if (readdirSync(f.directory).some((name) => name.startsWith("copy-"))) { allocated = true; throw new Error("unexpected allocation"); }
  })).rejects.toThrow();
  expect(allocated).toBe(false); expect(await readdir(f.directory)).toEqual(before);
});
it("copy entries over the cap report repo too large and clean the incomplete copy", async () => {
  const f = await setup(); await mkdir(join(f.directory, "many"));
  for (let i = 0; i < 20_001; i += 1) await symlink("../value.ts", join(f.directory, "many", String(i)));
  expect(await run(f, async () => ok)).toMatchObject({ reason: "repo_too_large", trustedAfter: true, counted: 0 });
  expect(await readdir(f.scratchRoot)).toEqual([]);
});
it("checks supported changes alongside a README", async () => {
  const f = await setup({ "value.ts": "const yes = true;\n", "README.md": "fixture\n" }); let calls = 0;
  expect(await run(f, async (directory) => { calls += 1; await writeFile(join(directory, "report.json"), report(calls === 1 ? "passed" : "failed")); return { ...ok, exitCode: calls === 1 ? 0 : 1 }; })).toMatchObject({ caught: 1, counted: 1, skippedLanguageFiles: 1 });
});
it.each(["ts", "js", "py"])("rejects syntax-invalid %s mutants before the test command", async (extension) => {
  const text = extension === "py" ? "value = True\nbad =\n" : "export const value = true;\nconst broken = ;\n";
  const f = await setup({ [`value.${extension}`]: text }); let tests = 0;
  const result = await run(f, async (directory, command) => {
    if (command.executable === "python3") {
      try { execFileSync(command.executable, command.args, { cwd: directory, stdio: "ignore" }); return ok; } catch { return { ...ok, exitCode: 1 }; }
    }
    tests += 1; await writeFile(join(directory, "report.json"), report(tests === 1 ? "passed" : "failed")); return { ...ok, exitCode: tests === 1 ? 0 : 1 };
  });
  expect(result.counted).toBe(0); expect(result.mutants.length).toBeGreaterThan(0);
  expect(result.mutants.every((mutant) => mutant.outcome === "invalid")).toBe(true); expect(tests).toBe(1);
});

it("a copy never carries a .git directory or a link to candidate metadata", async () => {
  const f = await setup(); const copy = await createMutationCopy(f.directory, f.scratchRoot);
  await expect(lstat(join(copy.directory, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(copy.directory)).toEqual(["value.ts"]);
});
it("normalizes absolute test paths across baseline and mutant copies", async () => {
  const f = await setup(); let calls = 0;
  const result = await run(f, async (directory) => {
    calls += 1;
    await writeFile(join(directory, "report.json"), report(calls === 1 ? "passed" : "failed").replace("test.ts", join(directory, "test.ts")));
    return { ...ok, exitCode: calls === 1 ? 0 : 1 };
  });
  expect(result).toMatchObject({ caught: 1, counted: 1 }); expect(calls).toBe(2);
});
it("excludes a flaky-looking mutant report with conflicting retries of the same test", async () => {
  const f = await setup(); let calls = 0;
  const result = await run(f, async (directory) => {
    calls += 1;
    const text = calls === 1 ? report("passed") : JSON.stringify({ testResults: [{ name: "test.ts", assertionResults: [{ fullName: "test", status: "failed" }, { fullName: "test", status: "passed" }] }] });
    await writeFile(join(directory, "report.json"), text); return { ...ok, exitCode: calls === 1 ? 0 : 1 };
  });
  expect(result).toMatchObject({ caught: 0, counted: 0, mutants: [{ outcome: "invalid" }] });
});
it("refuses ambiguous duplicate test identities in the baseline", async () => {
  const f = await setup();
  const result = await run(f, async (directory) => {
    await writeFile(join(directory, "report.json"), JSON.stringify({ testResults: [{ name: "test.ts", assertionResults: [{ fullName: "test", status: "passed" }, { fullName: "test", status: "passed" }] }] })); return ok;
  });
  expect(result).toMatchObject({ reason: "baseline_failed", counted: 0 });
});
it("does not count a surviving mutant when a baseline test disappeared", async () => {
  const f = await setup(); let calls = 0;
  const result = await run(f, async (directory) => {
    calls += 1;
    const text = calls === 1 ? JSON.stringify({ testResults: [{ name: "test.ts", assertionResults: [{ fullName: "test", status: "passed" }, { fullName: "second", status: "passed" }] }] }) : report("passed");
    await writeFile(join(directory, "report.json"), text); return ok;
  });
  expect(result).toMatchObject({ caught: 0, counted: 0, mutants: [{ outcome: "invalid" }] });
});
