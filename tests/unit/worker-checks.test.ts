// Spec 051 Task 3: AgentX reruns the project's readiness commands, or the agent's own test commands, within a budget.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProjectCommand } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import {
  createCheckRunners,
  planChecks,
  runChecks,
  type CheckRunners,
} from "../../packages/worker/src/verification/checks.js";
import { projectCheckKey, readCheckHistory, recordProjectOutcomes, type CheckHistory } from "../../packages/worker/src/verification/check-history.js";
import type { RecordedCommand } from "../../packages/worker/src/verification/recorder.js";
import { devcontainerBashOperations, type DevcontainerCli } from "../../packages/worker/src/devcontainer.js";

const run = promisify(execFile);
const MINUTE = 60_000;
const SECRET = "AKIAABCDEFGHIJKLMNOP";

const command = (executable: string, args: string[] = [], timeoutSeconds = 600): ProjectCommand => ({ cwd: ".", executable, args, timeoutSeconds });
const recorded = (replay: string, exitCode: number | undefined, afterFirstEdit = false, order = 0): RecordedCommand => ({
  order, command: replay, replay, exitCode, afterFirstEdit, output: "",
});
const recorderOf = (runs: RecordedCommand[]) => ({ firstRuns: () => runs.map((entry) => ({ ...entry })) });

function fakeRunners(overrides: Partial<CheckRunners> = {}): CheckRunners & { project: ProjectCommand[]; agent: Array<{ replay: string; timeoutMs: number }> } {
  const project: ProjectCommand[] = [];
  const agent: Array<{ replay: string; timeoutMs: number }> = [];
  return {
    project,
    agent,
    runProjectCommand: async (entry, signal) => {
      project.push(entry);
      return overrides.runProjectCommand?.(entry, signal) ?? { exitCode: 0, timedOut: false, stdout: "ok", stderr: "" };
    },
    runAgentCommand: async (replay, timeoutMs, signal) => {
      agent.push({ replay, timeoutMs });
      return overrides.runAgentCommand?.(replay, timeoutMs, signal) ?? { exitCode: 0, timedOut: false, output: "ok" };
    },
  };
}

/** History for a workspace whose preparation ran exactly these readiness commands, and no task has checked them yet. */
const prepared = (commands: ProjectCommand[]): CheckHistory => ({ lastOutcomes: {}, preparedKeys: commands.map(projectCheckKey) });
const planProject = (commands: ProjectCommand[]) => planChecks(commands, recorderOf([]), prepared(commands));

const budget = (signal = new AbortController().signal) => ({ budgetMs: 30 * MINUTE, signal });

describe("planChecks", () => {
  it("uses the project's readiness when there is some, else the agent's commands, else none (FR-002, FR-003)", () => {
    const runs = [recorded("pytest", 0)];
    expect(planChecks([command("npm", ["test"])], recorderOf(runs), prepared([command("npm", ["test"])]))).toEqual({
      source: "project", readiness: [command("npm", ["test"])], projectBefore: ["passed"],
    });
    // An old broker sends no readiness; a project without readiness sends none (Review Focus 5).
    expect(planChecks(undefined, recorderOf(runs))).toEqual({ source: "agent_commands", agentRuns: runs });
    expect(planChecks([], recorderOf(runs))).toEqual({ source: "agent_commands", agentRuns: runs });
    expect(planChecks(undefined, recorderOf([]))).toEqual({ source: "none" });
  });

  it("keeps at most 64 checks, the report's limit", () => {
    const runs = Array.from({ length: 70 }, (_, index) => recorded(`pytest -k t${index}`, 0, false, index));
    expect(planChecks(undefined, recorderOf(runs)).agentRuns).toHaveLength(64);
    expect(planChecks(Array.from({ length: 70 }, () => command("true")), recorderOf([])).readiness).toHaveLength(64);
  });
});

describe("the before of a project check (Ruling J)", () => {
  const lint = command("npm", ["run", "lint"]);
  const tests = command("npm", ["test"]);
  const failing = fakeRunners({ runProjectCommand: async () => ({ exitCode: 1, timedOut: false, stdout: "", stderr: "lint failed" }) });

  it("a check added after preparation that already fails has no before: failing_no_before, not a regression", async () => {
    const { entries } = await runChecks(planChecks([tests, lint], recorderOf([]), prepared([tests])), failing, budget());
    expect(entries.map(({ before, class: kind }) => ({ before, kind }))).toEqual([
      { before: "passed", kind: "regression" },
      { before: "unknown", kind: "failing_no_before" },
    ]);
  });

  it("without any history, a project check has no before", async () => {
    expect(planChecks([lint], recorderOf([])).projectBefore).toEqual(["unknown"]);
  });

  it("the key is the command's cwd, executable, args and env, not its timeout or the env's order", () => {
    expect(projectCheckKey({ ...lint, timeoutSeconds: 1 })).toBe(projectCheckKey(lint));
    expect(projectCheckKey({ ...lint, env: { A: "1", B: "2" } })).toBe(projectCheckKey({ ...lint, env: { B: "2", A: "1" } }));
    expect(projectCheckKey({ ...lint, env: { A: "1" } })).not.toBe(projectCheckKey(lint));
    expect(projectCheckKey({ ...lint, cwd: "repo/demo" })).not.toBe(projectCheckKey(lint));
    expect(projectCheckKey(command("npm", ["run lint"]))).not.toBe(projectCheckKey(lint));
    expect(projectCheckKey(lint)).toMatch(/^[0-9a-f]{64}$/);
  });

  async function workspace(preparedCommands: ProjectCommand[]) {
    const root = await mkdtemp(join(tmpdir(), "agentx-check-history-"));
    await mkdir(join(root, ".agentx"));
    const manifest = { readinessCommandKeys: preparedCommands.map(projectCheckKey) };
    return { root, manifest };
  }

  it("task 1 breaks a check; task 2 that still fails it finds it already failing", async () => {
    const { root, manifest } = await workspace([lint]);
    const first = planChecks([lint], recorderOf([]), await readCheckHistory(root, manifest));
    const round1 = await runChecks(first, failing, budget());
    expect(round1.entries[0]).toMatchObject({ before: "passed", class: "regression" });
    await recordProjectOutcomes(root, first, round1.entries);

    const second = planChecks([lint], recorderOf([]), await readCheckHistory(root, manifest));
    const round2 = await runChecks(second, failing, budget());
    expect(round2.entries[0]).toMatchObject({ before: "failed", after: "failed", class: "already_failing" });
  });

  it("task 1 fixed a check; task 2 finds it passed before", async () => {
    const { root, manifest } = await workspace([]);
    const first = planChecks([lint], recorderOf([]), await readCheckHistory(root, manifest));
    const round1 = await runChecks(first, fakeRunners(), budget());
    expect(round1.entries[0]).toMatchObject({ before: "unknown", after: "passed", class: "passing" });
    await recordProjectOutcomes(root, first, round1.entries);
    const second = planChecks([lint], recorderOf([]), await readCheckHistory(root, manifest));
    expect(second.projectBefore).toEqual(["passed"]);
    const round2 = await runChecks(second, failing, budget());
    expect(round2.entries[0]).toMatchObject({ class: "regression" });
  });

  it("a check not run keeps its last known outcome; only project checks are recorded; the file is written atomically", async () => {
    const { root, manifest } = await workspace([lint, tests]);
    const plan = planChecks([lint, tests], recorderOf([]), await readCheckHistory(root, manifest));
    const first = await runChecks(plan, failing, budget());
    await recordProjectOutcomes(root, plan, first.entries);
    const notRun = await runChecks(plan, fakeRunners(), { budgetMs: 0, signal: new AbortController().signal });
    await recordProjectOutcomes(root, plan, notRun.entries);
    // Agent-command plans record nothing.
    await recordProjectOutcomes(root, planChecks(undefined, recorderOf([recorded("pytest", 0)])), first.entries);
    const history = await readCheckHistory(root, manifest);
    expect(history.lastOutcomes).toEqual({ [projectCheckKey(lint)]: "failed", [projectCheckKey(tests)]: "failed" });
    expect((await readdir(join(root, ".agentx"))).sort()).toEqual(["last-checks.json"]);
  });

  it("a missing history file is no history; prepared commands still count as passed", async () => {
    const { root, manifest } = await workspace([lint]);
    await expect(readCheckHistory(root, manifest)).resolves.toEqual({ lastOutcomes: {}, preparedKeys: [projectCheckKey(lint)] });
    // A workspace prepared before the keys were recorded: nothing counts as prepared.
    await expect(readCheckHistory(root, {})).resolves.toEqual({ lastOutcomes: {}, preparedKeys: [] });
  });

  it("a history file that exists but cannot be used makes every before unknown, not passed (M-10, M-11)", async () => {
    const { root, manifest } = await workspace([lint]);
    const path = join(root, ".agentx", "last-checks.json");
    const none = { lastOutcomes: {}, preparedKeys: [] };
    await writeFile(path, "{not json");
    await expect(readCheckHistory(root, manifest)).resolves.toEqual(none);
    await writeFile(path, JSON.stringify({ schemaVersion: 2, outcomes: {} }));
    await expect(readCheckHistory(root, manifest)).resolves.toEqual(none);
    // Larger than 1 MiB: not read.
    await writeFile(path, JSON.stringify({ schemaVersion: 1, outcomes: {}, padding: "x".repeat(1_100_000) }));
    await expect(readCheckHistory(root, manifest)).resolves.toEqual(none);
    // A symlink (here to an endless device) is never followed.
    await rm(path);
    await symlink("/dev/zero", path);
    await expect(readCheckHistory(root, manifest)).resolves.toEqual(none);
  });
});

describe("runChecks", () => {
  it("reports a failing project check as a regression, its output redacted and cut to 64 KiB (FR-002, FR-005)", async () => {
    const long = `${"x".repeat(200)}\n`.repeat(1_000);
    const runners = fakeRunners({
      runProjectCommand: async (entry) => entry.executable === "lint"
        ? { exitCode: 0, timedOut: false, stdout: "clean", stderr: "" }
        : { exitCode: 1, timedOut: false, stdout: long, stderr: `token ${SECRET}\nFAILED 1 test\n` },
    });
    const { entries } = await runChecks(
      planProject([command("lint"), { ...command("npm", ["test"], 120), cwd: "repo/demo" }]),
      runners,
      budget(),
    );
    expect(entries.map(({ id, source, before, after, class: kind }) => ({ id, source, before, after, kind }))).toEqual([
      { id: "readiness:0", source: "project", before: "passed", after: "passed", kind: "passing" },
      { id: "readiness:1", source: "project", before: "passed", after: "failed", kind: "regression" },
    ]);
    expect(entries[1]!.label).toBe("npm test (in repo/demo)");
    expect(entries[1]!.output).not.toContain(SECRET);
    expect(entries[1]!.output).toContain("[REDACTED]");
    expect(entries[1]!.output).toMatch(/FAILED 1 test\n?$/);
    expect(Buffer.byteLength(entries[1]!.output)).toBeLessThanOrEqual(65_536);
    // Each project check keeps its own timeout.
    expect(runners.project.map((entry) => entry.timeoutSeconds)).toEqual([600, 120]);
  });

  it("an agent command that failed before the first edit and passes now is fixed (FR-003, FR-004)", async () => {
    const runners = fakeRunners();
    const { entries } = await runChecks(planChecks(undefined, recorderOf([recorded("cd pkg && npm test -- -t foo", 1)])), runners, budget());
    expect(entries).toEqual([expect.objectContaining({
      id: "agent:0", label: "cd pkg && npm test -- -t foo", source: "agent_commands", before: "failed", after: "passed", class: "fixed", output: "ok",
    })]);
    // Agent commands get 10 minutes each.
    expect(runners.agent).toEqual([{ replay: "cd pkg && npm test -- -t foo", timeoutMs: 10 * MINUTE }]);
  });

  it("an agent command first run after an edit that fails now has no before result (FR-003, FR-004)", async () => {
    const runners = fakeRunners({ runAgentCommand: async () => ({ exitCode: 2, timedOut: false, output: `FAILED ${SECRET}` }) });
    const { entries } = await runChecks(
      planChecks(undefined, recorderOf([recorded("pytest", 0, true), recorded("go test ./...", undefined, false, 1)])),
      runners,
      budget(),
    );
    expect(entries.map(({ id, before, after, class: kind }) => ({ id, before, after, kind }))).toEqual([
      { id: "agent:0", before: "unknown", after: "failed", kind: "failing_no_before" },
      { id: "agent:1", before: "unknown", after: "failed", kind: "failing_no_before" },
    ]);
    expect(entries[0]!.output).toBe("FAILED [REDACTED]");
  });

  it("a round that ran to the end is not stopped, even when the budget left checks unrun", async () => {
    const { stopped } = await runChecks(planProject([command("a")]), fakeRunners(), { budgetMs: 0, signal: new AbortController().signal });
    expect(stopped).toBe(false);
  });

  it("keeps a tail of both streams, so a long stderr cannot push stdout out (M-7)", async () => {
    const runners = fakeRunners({
      runProjectCommand: async () => ({ exitCode: 1, timedOut: false, stdout: "first line\nSTDOUT SUMMARY: 3 failed\n", stderr: `${"warning: noisy\n".repeat(20_000)}STDERR END\n` }),
    });
    const { entries } = await runChecks(planProject([command("npm", ["test"])]), runners, budget());
    expect(entries[0]!.output).toContain("STDOUT SUMMARY: 3 failed");
    expect(entries[0]!.output).toMatch(/STDERR END\n?$/);
    expect(Buffer.byteLength(entries[0]!.output)).toBeLessThanOrEqual(65_536);
  });

  it("no readiness and no agent commands: source none, and no entries", async () => {
    const plan = planChecks(undefined, recorderOf([]));
    expect(plan.source).toBe("none");
    await expect(runChecks(plan, fakeRunners(), budget())).resolves.toEqual({ entries: [], stopped: false });
  });

  it("caps each check at the budget left, and a check the budget cannot start is not run (P-3)", async () => {
    let clock = 0;
    const runners = fakeRunners({
      runProjectCommand: async (entry) => {
        // Each check would take 20 minutes; a capped one stops at its cap.
        const takes = Math.min(20 * MINUTE, entry.timeoutSeconds * 1_000);
        clock += takes;
        return takes < 20 * MINUTE
          ? { exitCode: null, timedOut: true, stdout: "", stderr: "" }
          : { exitCode: 0, timedOut: false, stdout: "ok", stderr: "" };
      },
    });
    const { entries } = await runChecks(
      planProject([command("a", [], 1_800), command("b", [], 1_800), command("c", [], 1_800)]),
      runners,
      { ...budget(), now: () => clock },
    );
    expect(entries.map(({ after, class: kind, durationMs }) => ({ after, kind, durationMs }))).toEqual([
      { after: "passed", kind: "passing", durationMs: 20 * MINUTE },
      // The budget stopped it, not its own timeout: no result, so no regression.
      { after: "not_run", kind: "not_rerun", durationMs: 10 * MINUTE },
      { after: "not_run", kind: "not_rerun", durationMs: 0 },
    ]);
    expect(runners.project.map((entry) => entry.timeoutSeconds)).toEqual([1_800, 600]);
    expect(entries[2]!.output).toMatch(/time budget/);
  });

  it("a check that its own timeout stops timed out", async () => {
    const runners = fakeRunners({ runAgentCommand: async () => ({ exitCode: null, timedOut: true, output: "slow" }) });
    const { entries } = await runChecks(planChecks(undefined, recorderOf([recorded("pytest", 0)])), runners, budget());
    expect(entries[0]).toMatchObject({ before: "passed", after: "timed_out", class: "regression" });
  });

  it("a check that cannot run fails, with the reason as its output", async () => {
    const runners = fakeRunners({ runProjectCommand: async () => { throw new Error(`directory does not exist in this workspace: repo/${SECRET}`); } });
    const { entries } = await runChecks(planProject([command("npm", ["test"])]), runners, budget());
    expect(entries[0]).toMatchObject({ after: "failed", class: "regression", output: "directory does not exist in this workspace: repo/[REDACTED]" });
  });

  it("an abort stops the running check within 100 ms, and the rest are not run (Review Focus 1)", async () => {
    const controller = new AbortController();
    let rejectedAt = 0;
    const runners = fakeRunners({
      runAgentCommand: (_replay, _timeoutMs, signal) => new Promise((_resolve, reject) => {
        // A sleeping check: it ends only when its signal kills it.
        signal.addEventListener("abort", () => { rejectedAt = Date.now(); reject(new Error("aborted")); }, { once: true });
      }),
    });
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 20);
    const { entries, stopped } = await runChecks(
      planChecks(undefined, recorderOf([recorded("pytest", 0), recorded("go test ./...", 0, false, 1)])),
      runners,
      budget(controller.signal),
    );
    // A stopped round says so, so the report is not_verified/stopped rather than no_checks (P-4).
    expect(stopped).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(120);
    expect(rejectedAt - startedAt).toBeLessThan(120);
    expect(entries.map((entry) => entry.after)).toEqual(["not_run", "not_run"]);
    expect(runners.agent).toHaveLength(1);
  });

  it("an abort returns at once even when a runner ignores its signal", async () => {
    const controller = new AbortController();
    const runners = fakeRunners({ runProjectCommand: () => new Promise(() => undefined) });
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 20);
    const { entries } = await runChecks(planChecks([command("a"), command("b")], recorderOf([])), runners, budget(controller.signal));
    expect(Date.now() - startedAt).toBeLessThan(120);
    expect(entries.map((entry) => entry.after)).toEqual(["not_run", "not_run"]);
  });

  it("runs nothing when the signal has already fired", async () => {
    const controller = new AbortController();
    controller.abort();
    const runners = fakeRunners();
    const { entries, stopped } = await runChecks(planChecks([command("a")], recorderOf([])), runners, budget(controller.signal));
    expect(stopped).toBe(true);
    expect(entries.map((entry) => entry.after)).toEqual(["not_run"]);
    expect(runners.project).toHaveLength(0);
  });
});

/** A temp git repository with a Makefile whose `test` target the agent might run, and a symlink that leaves it. */
async function repository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-checks-")));
  const outside = await realpath(await mkdtemp(join(tmpdir(), "agentx-checks-outside-")));
  await run("git", ["init", "--quiet", root]);
  await mkdir(join(root, "pkg"));
  await writeFile(join(root, "pkg", "Makefile"), "test:\n\t@echo \"in $$(pwd) as $$GIT_AUTHOR_NAME\"\n\t@exit 3\nslow:\n\t@sleep 30\n");
  await writeFile(join(outside, "Makefile"), "test:\n\t@echo escaped\n");
  await symlink(outside, join(root, "link"));
  return { root, outside };
}

describe("createCheckRunners on the host", () => {
  it("runs a readiness command in its directory, and the agent's command from the workspace root with the AgentX identity", async () => {
    const { root } = await repository();
    const runners = createCheckRunners({ rootPath: root });
    const signal = new AbortController().signal;
    await expect(runners.runProjectCommand({ cwd: "pkg", executable: "sh", args: ["-c", "pwd; echo err >&2; exit 4"], timeoutSeconds: 30 }, signal))
      .resolves.toEqual({ exitCode: 4, timedOut: false, stdout: `${root}/pkg\n`, stderr: "err\n" });
    const agent = await runners.runAgentCommand("cd pkg && make test", 30_000, signal);
    expect(agent.exitCode).not.toBe(0);
    expect(agent.timedOut).toBe(false);
    expect(agent.output).toContain(`in ${root}/pkg as AgentX`);
  });

  it("refuses to replay a cd through a symlink that leaves the workspace, and records it as not run (Ruling D)", async () => {
    const { root } = await repository();
    const runners = createCheckRunners({ rootPath: root });
    const { entries } = await runChecks(planChecks(undefined, recorderOf([recorded("cd link && make test", 0)])), runners, budget());
    expect(entries[0]).toMatchObject({ after: "not_run", class: "not_rerun" });
    expect(entries[0]!.output).toMatch(/outside the workspace/);
    expect(entries[0]!.output).not.toContain("escaped");
  });

  it("refuses a cd through a symlink to a file outside the workspace: not run, not failed (M-13)", async () => {
    const { root, outside } = await repository();
    await symlink(join(outside, "Makefile"), join(root, "file-link"));
    const runners = createCheckRunners({ rootPath: root });
    const { entries } = await runChecks(planChecks(undefined, recorderOf([recorded("cd file-link && make test", 0)])), runners, budget());
    expect(entries[0]).toMatchObject({ after: "not_run", class: "not_rerun" });
    expect(entries[0]!.output).toMatch(/outside the workspace/);
  });

  it("refuses a replay that is not a simple test command", async () => {
    const { root } = await repository();
    const runners = createCheckRunners({ rootPath: root });
    const { entries } = await runChecks(planChecks(undefined, recorderOf([recorded("make test; rm -rf pkg", 0)])), runners, budget());
    expect(entries[0]).toMatchObject({ after: "not_run" });
  });

  it("stops a sleeping readiness command on abort, and the round leaves the rest not run (Review Focus 1)", async () => {
    const { root } = await repository();
    const runners = createCheckRunners({ rootPath: root });
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 200);
    const { entries } = await runChecks(
      planChecks([{ cwd: "pkg", executable: "make", args: ["slow"], timeoutSeconds: 60 }, command("true")], recorderOf([])),
      runners,
      budget(controller.signal),
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(entries.map((entry) => entry.after)).toEqual(["not_run", "not_run"]);

    const sleeping = new AbortController();
    const sleepingAt = Date.now();
    setTimeout(() => sleeping.abort(), 200);
    await expect(runners.runProjectCommand({ cwd: "pkg", executable: "sleep", args: ["30"], timeoutSeconds: 60 }, sleeping.signal)).rejects.toThrow(/aborted/);
    expect(Date.now() - sleepingAt).toBeLessThan(2_000);
  });

  it("stops a sleeping agent command on abort: it rejects promptly", async () => {
    const { root } = await repository();
    await writeFile(join(root, "Makefile"), "test:\n\t@sleep 30\n");
    const runners = createCheckRunners({ rootPath: root });
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 200);
    await expect(runners.runAgentCommand("make test", 60_000, controller.signal)).rejects.toThrow(/aborted/);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("keeps the worker's absolute path out of a failure message (M-4)", async () => {
    const { root } = await repository();
    const runners = createCheckRunners({ rootPath: root });
    const { entries } = await runChecks(
      planChecks([{ cwd: "pkg", executable: "no-such-tool-agentx", args: [], timeoutSeconds: 5 }], recorderOf([]), prepared([])),
      runners,
      budget(),
    );
    const missing = await runChecks(planChecks(undefined, recorderOf([recorded("cd pkg/Makefile && make test", 0)])), runners, budget());
    for (const entry of [...entries, ...missing.entries]) {
      expect(entry.after).toBe("failed");
      expect(entry.output).not.toContain(root);
    }
    expect(missing.entries[0]!.output).toMatch(/not a directory/);
  });

  it("reports an agent command that its timeout stopped", async () => {
    const { root } = await repository();
    await writeFile(join(root, "Makefile"), "test:\n\t@sleep 30\n");
    const runners = createCheckRunners({ rootPath: root });
    await expect(runners.runAgentCommand("make test", 1_000, new AbortController().signal)).resolves.toMatchObject({ timedOut: true, exitCode: null });
  });
});

describe("createCheckRunners with a devcontainer", () => {
  /** A fake devcontainer CLI: each command runs until its client is aborted; kill execs answer at once. */
  function stoppableCli() {
    const calls: string[][] = [];
    const cli: DevcontainerCli = {
      run: (args, options) => {
        calls.push([...args]);
        if (args.some((arg) => arg.includes("kill -TERM") || arg.includes("kill -KILL"))) return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        return new Promise((resolve) => {
          options.signal?.addEventListener("abort", () => resolve({ exitCode: null, stdout: "", stderr: "" }), { once: true });
        });
      },
    };
    return { cli, calls };
  }

  it("runs readiness in the devcontainer, and an abort stops its process group there promptly", async () => {
    const { root } = await repository();
    const target = { rootPath: root, workspaceFolder: join(root, "pkg"), configPath: join(root, "pkg", ".devcontainer", "devcontainer.json") };
    const { cli, calls } = stoppableCli();
    const runners = createCheckRunners({ rootPath: root, devcontainer: { cli, target } });
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 50);
    await expect(runners.runProjectCommand({ cwd: "pkg", executable: "sleep", args: ["300"], timeoutSeconds: 600 }, controller.signal)).rejects.toThrow(/aborted/);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(calls[0]!.slice(0, 1)).toEqual(["exec"]);
    expect(calls[0]).toEqual(expect.arrayContaining([`${root}/pkg`, "sleep", "300"]));
    // The TERM exec went to the container's process group.
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    expect(calls.some((args) => args.some((arg) => arg.includes("kill -TERM")))).toBe(true);
  });

  it("replays the agent's command in the devcontainer by default, never on the host (Ruling K)", async () => {
    const { root } = await repository();
    const target = { rootPath: root, workspaceFolder: join(root, "pkg"), configPath: join(root, "pkg", ".devcontainer", "devcontainer.json") };
    const calls: string[][] = [];
    const cli: DevcontainerCli = {
      run: (args) => {
        calls.push([...args]);
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    };
    const runners = createCheckRunners({ rootPath: root, devcontainer: { cli, target } });
    // On the host, this Makefile exits 3 and prints the directory; through the fake CLI it passes silently.
    await expect(runners.runAgentCommand("cd pkg && make test", 60_000, new AbortController().signal))
      .resolves.toEqual({ exitCode: 0, timedOut: false, output: "" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 5)).toEqual(["exec", "--workspace-folder", target.workspaceFolder, "--config", target.configPath]);
    expect(calls[0]!.at(-1)).toBe("make test");
  });

  it("a cd the host cannot resolve in a devcontainer session is not run, not failed: the link may be valid in the container", async () => {
    const { root } = await repository();
    await symlink("/workspaces/demo/build", join(root, "container-link"));
    const target = { rootPath: root, workspaceFolder: join(root, "pkg"), configPath: join(root, "pkg", ".devcontainer", "devcontainer.json") };
    const cli: DevcontainerCli = { run: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }) };
    const runners = createCheckRunners({ rootPath: root, devcontainer: { cli, target } });
    const { entries } = await runChecks(planChecks(undefined, recorderOf([recorded("cd container-link && make test", 0)])), runners, budget());
    expect(entries[0]).toMatchObject({ after: "not_run", class: "not_rerun" });
  });

  it("replays the agent's command through the session's bash operations, from the resolved directory", async () => {
    const { root } = await repository();
    const target = { rootPath: root, workspaceFolder: join(root, "pkg"), configPath: join(root, "pkg", ".devcontainer", "devcontainer.json") };
    const calls: string[][] = [];
    const cli: DevcontainerCli = {
      run: (args, options) => {
        calls.push([...args]);
        options.onStdout?.(Buffer.from("1 passed\n"));
        return Promise.resolve({ exitCode: 0, stdout: "1 passed\n", stderr: "" });
      },
    };
    const runners = createCheckRunners({ rootPath: root, devcontainer: { cli, target }, bashOperations: devcontainerBashOperations(cli, target) });
    await expect(runners.runAgentCommand("cd pkg && pytest -k x", 60_000, new AbortController().signal))
      .resolves.toEqual({ exitCode: 0, timedOut: false, output: "1 passed\n" });
    const shell = calls[0]!;
    expect(shell.slice(-3, -2)).toEqual([`${root}/pkg`]);
    expect(shell.at(-1)).toBe("pytest -k x");
    expect(shell).toEqual(expect.arrayContaining(["--remote-env", "GIT_AUTHOR_NAME=AgentX"]));
  });
});
