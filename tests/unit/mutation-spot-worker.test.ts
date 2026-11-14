import "./mutation-spot-offline.js";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCandidateWriteHookForTests } from "../../packages/worker/src/candidate-fs.js";
import { runMutationSpotCheck, type MutationSpotOptions } from "../../packages/worker/src/verification/mutation-spot-check.js";
import { createMutationCopy, snapshotCandidate, writeScratchMutant } from "../../packages/worker/src/verification/mutation-restore.js";
import { fixture, report } from "./mutation-spot-support.js";

const roots: string[] = [];
afterEach(async () => { setCandidateWriteHookForTests(undefined); vi.useRealTimers(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup(files?: Record<string, string>) { const f = await fixture(files); roots.push(f.root); return f; }
const ok = { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function run(f: Awaited<ReturnType<typeof fixture>>, body: (directory: string, command: Parameters<ReturnType<MutationSpotOptions["runners"]>["runProjectCommand"]>[0], signal: AbortSignal) => Promise<typeof ok> = async (directory) => { await writeFile(join(directory, "report.json"), report("failed")); return { ...ok, exitCode: 1 }; }, extra: Partial<MutationSpotOptions> = {}) {
  const originals = await Promise.all(f.git("ls-files", "-z").split("\0").filter((path) => /\.(?:[cm]?[jt]sx?|py)$/u.test(path)).map(async (path) => ({ path, bytes: await readFile(join(f.directory, path)).catch(() => undefined) })));
  return runMutationSpotCheck({ repositories: [f.repository], selection: f.selection, seed: f.repository.candidateTreeSha, scratchRoot: f.scratchRoot,
    runners: (directory) => ({ runProjectCommand: async (command, signal) => {
      const pristine = (await Promise.all(originals.map(async ({ path, bytes }) => bytes !== undefined && bytes.equals(await readFile(join(directory, path)).catch(() => Buffer.alloc(0)))))).every(Boolean);
      if (pristine) { await writeFile(join(directory, "report.json"), report("passed")); return ok; }
      return body(directory, command, signal);
    }, runAgentCommand: async () => { throw new Error("no agent replays"); } }), ...extra });
}

describe("disposable mutation checks", () => {
  it("runs a changed-line mutant only in a hard-link-free copy, then leaves candidate bytes, modes, index and status unchanged", async () => {
    const f = await setup();
    await chmod(join(f.directory, "value.ts"), 0o755);
    const before = await snapshotCandidate(f.directory);
    const index = digest(await readFile(join(f.directory, ".git/index")));
    const result = await run(f, async (directory, command) => {
      expect(directory).not.toBe(f.directory);
      expect((await lstat(join(directory, "value.ts"))).nlink).toBe(1);
      expect(await readFile(join(directory, "value.ts"), "utf8")).toBe("export const value = false;\n");
      expect(command.args).toContain("test.ts");
      expect(command.args).not.toContain("other1.ts");
      await writeFile(join(directory, "report.json"), report("failed"));
      return { ...ok, exitCode: 1 };
    });
    expect(result).toMatchObject({ status: "completed", trustedAfter: true, caught: 1, counted: 1, mutants: [{ outcome: "caught", method: "coverage_map", line: 1, operator: "boolean" }] });
    expect(await snapshotCandidate(f.directory)).toEqual(before);
    expect(digest(await readFile(join(f.directory, ".git/index")))).toBe(index);
  });
  it.each(["symlink_file", "symlink_parent", "hardlink"])("refuses %s with an unchanged outside sentinel", async (kind) => {
    const f = await setup({ "src/value.ts": "const yes = true;\n" });
    const sentinel = join(f.root, "sentinel");
    await writeFile(sentinel, "const yes = true;\n");
    const before = digest(await readFile(sentinel));
    if (kind === "symlink_parent") {
      await rename(join(f.directory, "src"), join(f.root, "outside"));
      await symlink(join(f.root, "outside"), join(f.directory, "src"));
    } else {
      await rm(join(f.directory, "src/value.ts"));
      if (kind === "hardlink") await link(sentinel, join(f.directory, "src/value.ts"));
      else await symlink(sentinel, join(f.directory, "src/value.ts"));
    }
    let calls = 0;
    const result = await run(f, async () => { calls += 1; return ok; });
    expect(result.status).toBe("not_run");
    expect(calls).toBe(0);
    expect(digest(await readFile(sentinel))).toBe(before);
  });
  it.each(["../sentinel", ".git/hooks/hook", "/absolute", "a/../../sentinel"])("refuses an unsafe write path %s", async (path) => {
    const f = await setup();
    const before = await snapshotCandidate(f.directory);
    const copy = await createMutationCopy(f.directory, f.scratchRoot);
    await mkdir(join(copy.directory, ".git/hooks"), { recursive: true });
    await mkdir(join(copy.directory, "a"));
    await writeFile(join(copy.directory, ".git/hooks/hook"), "x");
    await writeFile(join(f.scratchRoot, "sentinel"), "x");
    const unsafe = path === "/absolute" ? join(f.scratchRoot, "sentinel") : path;
    await expect(writeScratchMutant(copy, { path: unsafe, line: 1, start: 0, end: 1, replacement: "x", operator: "boolean" }, "x")).rejects.toThrow();
    expect(await snapshotCandidate(f.directory)).toEqual(before);
  });
  it("refuses a leaf swapped for a symlink between check and write", async () => {
    const f = await setup();
    const sentinel = join(f.root, "sentinel");
    await writeFile(sentinel, "export const value = true;\n");
    const copy = await createMutationCopy(f.directory, f.scratchRoot);
    setCandidateWriteHookForTests(async (step) => {
      if (step !== "mutation write") return;
      await rm(join(copy.directory, "value.ts"));
      await symlink(sentinel, join(copy.directory, "value.ts"));
    });
    await expect(writeScratchMutant(copy, { path: "value.ts", line: 1, start: 21, end: 25, replacement: "false", operator: "boolean" }, "export const value = true;\n")).rejects.toThrow();
    expect(await readFile(sentinel, "utf8")).toBe("export const value = true;\n");
  });
  it("ignores claimed changes and plans only the Git diff", async () => {
    const f = await setup({ "value.ts": "const old = true;\nconst fresh = false;\n" });
    const first = f.git("rev-parse", "HEAD");
    await writeFile(join(f.directory, "value.ts"), "const old = true;\nconst fresh = true;\n");
    f.git("add", "--all"); f.git("commit", "--quiet", "-m", "fixture update");
    const result = await run(f, undefined, { repositories: [{ ...f.repository, startCommit: first, candidateTreeSha: f.git("rev-parse", "HEAD^{tree}") }], changes: [{ path: "value.ts", hunks: [[1, 1]] }] });
    expect(result.mutants).toHaveLength(1);
    expect(result.mutants[0]?.line).toBe(2);
  });
  it.each(["bytes", "mode", "status"])("fails closed if candidate %s change during the run", async (kind) => {
    const f = await setup();
    if (kind !== "status") f.git("update-index", "--assume-unchanged", "value.ts");
    const result = await run(f, async (directory) => {
      if (kind === "bytes") await writeFile(join(f.directory, "value.ts"), "export const value = null;\n");
      if (kind === "mode") await chmod(join(f.directory, "value.ts"), 0o755);
      if (kind === "status") { f.git("update-index", "--chmod=+x", "value.ts"); }
      await writeFile(join(directory, "report.json"), report("failed")); return { ...ok, exitCode: 1 };
    });
    expect(result).toMatchObject({ status: "not_run", reason: "candidate_changed", trustedAfter: false, caught: 0, counted: 0 });
  });
  it.each([
    ["passed", 0, "survived", 0, 1], ["failed", 1, "caught", 1, 1], ["skipped", 0, "invalid", 0, 0], ["none", 1, "invalid", 0, 0], ["collection", 1, "invalid", 0, 0], ["passed", 1, "invalid", 0, 0],
  ] as const)("classifies %s/%s from fresh test results only", async (status, exitCode, outcome, caught, counted) => {
    const f = await setup();
    const result = await run(f, async (directory) => {
      if (status === "collection") await writeFile(join(directory, "report.json"), JSON.stringify({ testResults: [{ name: "test.ts", status: "failed", assertionResults: [] }] }));
      else if (status !== "none") await writeFile(join(directory, "report.json"), report(status));
      return { ...ok, exitCode, stdout: "# evil @all ![image](https://example.invalid) <script> __proto__", stderr: "test failed" };
    });
    expect(result).toMatchObject({ caught, counted, mutants: [{ outcome }] });
    if (counted === 0) expect(result.reason).toBe("no_results");
    expect(JSON.stringify(result)).not.toMatch(/evil|example|script|value\.ts|test\.ts|__proto__/u);
  });
  it("does not accept an old copied report as a fresh result", async () => {
    const f = await setup({ "value.ts": "const yes = true;\n", "report.json": report("failed") });
    // A non-language report is unchanged in this diff, but exists in the scratch copy.
    f.repository.startCommit = f.git("rev-parse", "HEAD");
    await writeFile(join(f.directory, "value.ts"), "const yes = false;\n");
    f.git("add", "--all"); f.git("commit", "--quiet", "-m", "fixture change");
    f.repository.candidateTreeSha = f.git("rev-parse", "HEAD^{tree}");
    const result = await run(f, async () => ok);
    expect(result).toMatchObject({ caught: 0, counted: 0, mutants: [{ outcome: "invalid" }] });
  });
  it("falls from missing coverage to imports and then the affected test set", async () => {
    const f = await setup();
    delete f.selection[0]!.coverageMap;
    f.selection[0]!.importGraph = new Map([["test.ts", new Set(["value.ts"])]]);
    expect((await run(f)).mutants[0]?.method).toBe("import_graph");
    delete f.selection[0]!.importGraph;
    expect((await run(f)).mutants[0]?.method).toBe("affected");
  });
  it("never silently runs the full command without a valid selection template", async () => {
    const f = await setup(); f.selection[0]!.check.selectArgs = [];
    let calls = 0;
    const result = await run(f, async () => { calls += 1; return ok; });
    expect(result.counted).toBe(0); expect(calls).toBe(0);
  });
  it("caps each run by time left, excludes overruns and starts no later mutant", async () => {
    const f = await setup({ "value.ts": "const yes = true;\nconst no = false;\n" });
    let now = 0; let calls = 0;
    const result = await run(f, async (directory, command) => {
      calls += 1; expect(command.timeoutSeconds).toBeLessThanOrEqual(2);
      await writeFile(join(directory, "report.json"), report("failed"));
      now = 2_001; return { ...ok, exitCode: 1 };
    }, { clock: () => now, limits: { totalTimeMs: 2_000, perMutantTimeMs: 50_000 } });
    expect(calls).toBe(1); expect(result.counted).toBe(0);
    expect(result.mutants[0]?.outcome).toBe("timed_out");
  });
  it("aborts a hung runner and discards its timeout report", async () => {
    const f = await setup(); let aborted = false;
    const result = await run(f, async (_directory, _command, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; resolve({ ...ok, exitCode: 1 }); }, { once: true });
    }), { limits: { perMutantTimeMs: 30, totalTimeMs: 20_000 } });
    expect(aborted).toBe(true); expect(result).toMatchObject({ caught: 0, counted: 0, mutants: [{ outcome: "timed_out" }] });
  });
  it("handles a forced scratch write failure without ever restoring the candidate", async () => {
    const f = await setup(); const before = await snapshotCandidate(f.directory);
    setCandidateWriteHookForTests(async (step) => { if (step === "mutation write") throw new Error("simulated disk failure"); });
    const result = await run(f);
    expect(result.status).toBe("not_run"); expect(await snapshotCandidate(f.directory)).toEqual(before);
  });
  it("rejects an unsupported changed language before running commands", async () => {
    const f = await setup({ "value.go": "const yes = true;\n" }); let calls = 0;
    const result = await run(f, async () => { calls += 1; return ok; });
    expect(result.reason).toBe("unsupported_language"); expect(calls).toBe(0);
  });
  it("refuses a scratch parent inside any candidate before creating a directory", async () => {
    const f = await setup(); const names = await readdir(f.directory);
    let calls = 0;
    const result = await run(f, async () => { calls += 1; return ok; }, { scratchRoot: f.directory });
    expect(result.status).toBe("not_run"); expect(calls).toBe(0);
    expect(await readdir(f.directory)).toEqual(names);
  });
  it("uses a different pristine copy for every mutant", async () => {
    const f = await setup({ "value.ts": "const a = true;\nconst b = false;\n" });
    const directories = new Set<string>();
    const result = await run(f, async (directory) => {
      expect(directories.has(directory)).toBe(false); directories.add(directory);
      expect(await readFile(join(directory, "previous-run"), "utf8").catch(() => "missing")).toBe("missing");
      await writeFile(join(directory, "previous-run"), "yes");
      await writeFile(join(directory, "report.json"), report("failed")); return { ...ok, exitCode: 1 };
    });
    expect(result).toMatchObject({ caught: 2, counted: 2 }); expect(directories.size).toBe(2);
  });
  it("refuses stale candidate source bytes even when the hinted changed lines look valid", async () => {
    const f = await setup(); await writeFile(join(f.directory, "value.ts"), "const changed = false;\n");
    let calls = 0;
    const result = await run(f, async () => { calls += 1; return ok; });
    expect(result.status).toBe("not_run"); expect(calls).toBe(0);
  });
  it("does not compare untracked or ignored artifacts", async () => {
    const f = await setup();
    const result = await run(f, async (directory) => {
      await writeFile(join(f.directory, "untracked"), "test artifact");
      await writeFile(join(directory, "report.json"), report("passed")); return ok;
    });
    expect(result).toMatchObject({ trustedAfter: true, counted: 1 });
  });
  it("rejects a forged copy capability without touching the candidate", async () => {
    const f = await setup(); const before = await snapshotCandidate(f.directory);
    await expect(writeScratchMutant({ directory: f.directory }, { path: "value.ts", line: 1, start: 21, end: 25, replacement: "false", operator: "boolean" }, "export const value = true;\n")).rejects.toThrow();
    expect(await snapshotCandidate(f.directory)).toEqual(before);
  });

  it("aborts at the exact per-mutant timer deadline", async () => {
    const f = await setup(); const control = new AbortController(); let aborted = false; let baseline = true;
    let ready: () => void = () => undefined; const started = new Promise<void>((resolve) => { ready = resolve; });
    const running = run(f, undefined, { signal: control.signal, limits: { perMutantTimeMs: 30 }, runners: (directory) => {
      if (baseline) { baseline = false; return { runAgentCommand: async () => { throw new Error("no agent"); }, runProjectCommand: async () => { await writeFile(join(directory, "report.json"), report("passed")); return ok; } }; }
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      return { runAgentCommand: async () => { throw new Error("not used"); }, runProjectCommand: async (_command, signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => { aborted = true; resolve(ok); }, { once: true }); ready();
      }) };
    } });
    try {
      await started;
      await vi.advanceTimersByTimeAsync(29); expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(aborted).toBe(true);
      vi.useRealTimers();
      expect(await running).toMatchObject({ counted: 0, mutants: [{ outcome: "timed_out" }] });
    } finally { control.abort(); vi.useRealTimers(); await running; }
  });

  it("accepts a safe path at the exact 512-character boundary", async () => {
    const path = `${"a".repeat(250)}/${"b".repeat(250)}/valuess.ts`;
    expect(path.length).toBe(512);
    const f = await setup({ [path]: "const yes = true;\n" });
    expect(await run(f)).toMatchObject({ trustedAfter: true, caught: 1, counted: 1 });
  });

});
