// DEC 254zzz495 / N0: a setup run leaves ONE summary line in the log when it ends (`setup_run_ended`): counts of commands and how they ended (passed, nothing found, failed, timed out), the setup and test commands the
// proposal holds, and where it looked for tests as words from a fixed list. It never holds a command, an output, a path or a website's name.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, SETUP_RUN_END_WORDS, type SetupJournalEntry, type SetupProposal } from "@agentx/contracts";
import { TEST_PLACES, setupRunEndedLine, testPlacesLooked } from "../../packages/broker/src/core/setup-agent/end-summary.js";
import { appendSetupJournal } from "../../packages/broker/src/core/setup-agent/journal.js";
import { SETUP_RUN_SILENT_MS } from "../../packages/broker/src/core/setup-agent/agent.js";
import { operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { change } from "@agentx/contracts";
import { endSetupAgentTask } from "../../packages/broker/src/core/setup-agent/end.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { createHarness, newRequestId, type Harness } from "../support/task-flow-harness.js";

const entry = (n: number, command: string, over: Partial<SetupJournalEntry> = {}): SetupJournalEntry => ({
  n, source: "agent", command, exitCode: 0, durationMs: 1_000, timedOut: false, flagged: false, blockedHosts: [], tail: "", startedAt: "2026-11-24T10:00:00.000Z", ...over,
});
const item = (id: string, commands: string[]) => ({ id, value: { repo: "web", commands }, from: [{ kind: "inferred", repo: "web", note: "worked when run" }], confidence: "high", risk: "low" });
const proposal = (over: Record<string, unknown> = {}): SetupProposal => ({
  version: 2, basedOnRevision: 1, repositories: [], setup: [item("setup-web", ["npm ci", "npm run build"])], tests: [item("tests-web", ["npm test"])], checks: [], testEnvironment: [], knowledge: [],
  sources: [], intake: [], allowedDomains: [], secretsNeeded: [], flaggedCommands: [], foundNotUsed: [], notes: "", ...over,
} as unknown as SetupProposal);
/** A made-up word planted in a command, an output and a proposal's notes, to prove none of it reaches the line. */
const SETUP_SECRET_NEEDLE = "canary-word-n0-4f9a2c71";
const summary = { stop: "proposed", commandsRun: 4, spendCents: 37, elapsedMs: 125_400, hostAsks: 1, partial: false } as const;

const KEYS = ["blockedHosts", "commandsRun", "elapsedSeconds", "event", "failed", "hostAsks", "nothingFound", "otherItems", "partial", "passed", "project", "setupFound", "spendCents", "status", "stop", "testsFound", "testsLookedIn", "timedOut"];

describe("setupRunEndedLine", () => {
  const journal = [
    entry(1, "npm ci"),
    entry(2, "grep -rn pytest . 2>/dev/null", { exitCode: 1 }),
    entry(3, "cd repo/x && source .venv/bin/activate && find . -name '*test*' | grep -v node_modules", { exitCode: 1 }),
    entry(4, "npm test", { exitCode: 1, tail: "1 failed" }),
    entry(5, "npm run build", { exitCode: null, timedOut: true }),
    entry(6, "curl https://cdn.example.dev/x", { exitCode: 6, blockedHosts: ["cdn.example.dev"] }),
    entry(7, "curl https://cdn.example.dev/y", { exitCode: 6, blockedHosts: ["cdn.example.dev", "registry.example.dev"] }),
  ];
  it("counts the commands by how they ended, the setup and test commands found, the other items, the blocked websites, the spend and the time", () => {
    const line = setupRunEndedLine({ project: "payments", result: { status: "ready", stop: "proposed", proposal: proposal({ checks: [{ id: "check-web", value: { name: "lint", repo: "web", command: "npm run lint" }, from: [{ kind: "inferred", note: "x" }], confidence: "high", risk: "low" }] }), summary }, journal });
    expect(line).toEqual({
      event: "setup_run_ended", project: "payments", stop: "proposed", status: "ready", commandsRun: 7, passed: 1, nothingFound: 1, failed: 4, timedOut: 1, setupFound: 2, testsFound: 1, otherItems: 1,
      testsLookedIn: ["tests_folder", "package_scripts"], blockedHosts: 2, hostAsks: 1, spendCents: 37, elapsedSeconds: 125, partial: false,
    });
  });
  it("a run with no proposal and no summary still has a line (zeros, partial)", () => {
    const line = setupRunEndedLine({ project: "payments", result: { status: "failed", stop: "infrastructure" }, journal: [] });
    expect(line).toMatchObject({ stop: "infrastructure", status: "failed", commandsRun: 0, passed: 0, nothingFound: 0, failed: 0, setupFound: 0, testsFound: 0, otherItems: 0, testsLookedIn: [], spendCents: 0, partial: true });
  });
  it("has exactly these keys for every stop word, and never a command, an output, a path, a website name or a model's words", () => {
    for (const stop of SETUP_RUN_END_WORDS) {
      const line = setupRunEndedLine({
        project: "payments", result: { status: stop === "proposed" ? "ready" : "failed", stop, proposal: proposal({ notes: SETUP_SECRET_NEEDLE }), summary },
        journal: [...journal, entry(8, `echo ${SETUP_SECRET_NEEDLE}`, { tail: SETUP_SECRET_NEEDLE })],
      });
      expect(Object.keys(line).sort(), stop).toEqual(KEYS);
      expect(line.stop).toBe(stop);
      const text = JSON.stringify(line);
      for (const forbidden of [SETUP_SECRET_NEEDLE, "npm", "cdn.example.dev", "registry.example.dev", "repo/x", ".venv", "pytest -", "grep"]) expect(text, `${stop}: ${forbidden}`).not.toContain(forbidden);
      for (const place of line.testsLookedIn) expect(TEST_PLACES).toContain(place);
    }
  });
});

describe("testPlacesLooked: where the run looked for tests, as words from a fixed list", () => {
  it("names the places a command's words point at, in the list's order, and nothing else", () => {
    expect(testPlacesLooked(["ls", "npm ci"])).toEqual([]);
    expect(testPlacesLooked(["find . -name 'test_*.py'", "grep -r pytest pytest.ini pyproject.toml tox.ini", "ls tests/", "cat conftest.py"]))
      .toEqual(["pytest_config", "tests_folder", "test_py_files", "conftest"]);
    expect(testPlacesLooked(["cat package.json", "find . -name '*.test.ts'", "ls .github/workflows", "grep -n test Makefile", "ls src/test", "find . -name '*_test.go'", "cat README.md"]))
      .toEqual(["tests_folder", "package_scripts", "js_test_files", "go_test_files", "java_src_test", "makefile", "ci_workflows", "readme"]);
  });
  it("every word is on the fixed list whatever the command says", () => {
    for (const place of testPlacesLooked(["find / -name 'test_*.py' conftest.py pytest.ini package.json tests/ README Makefile .github/workflows src/test _test.go *.spec.js"])) expect(TEST_PLACES).toContain(place);
  });
});

describe("the end of a real setup run writes the line once (the task flow's end)", () => {
  async function runningSetup(h: Harness) {
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Set up the project", workflow: true, workflowPath: "FULL" });
    const drain = async (): Promise<void> => { for (let round = 0; round < 12; round += 1) { if ((await h.flow.dispatchOnce({ maxMessages: 10 })).received === 0) return; h.clock.advance(70); } };
    await drain();
    const workspace = (await h.store.get(workspaceKey(IMPLICIT_COMPANY_ID, started.task.workspaceId))) as unknown as WorkspaceRecord;
    const machineId = workspace.machine!.machineId;
    const prepare = h.machines.delivered(machineId).at(-1)!;
    h.machines.finish(machineId, prepare.operationId);
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED", outcome: { kind: "prepared" } });
    await drain();
    const plan = h.machines.delivered(machineId).at(-1)!;
    const seen = new Date(h.deps.now!().getTime() - 30_000).toISOString();
    await h.store.update({ key: operationKey(IMPLICIT_COMPANY_ID, workspace.id, plan.operationId), ops: [change.set("workflowMode", "SETUP_AGENT")] });
    await h.store.update({ key: taskKey(started.task.taskId), ops: [change.set("purpose", "setup_agent"), change.set("setupAgentSeenAt", seen)] });
    return { taskId: started.task.taskId };
  }
  it("logs setup_run_ended with the journal's counts when the run ends, and not again on a repeat", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const h = createHarness({ extra: () => ({ log: (logged: Record<string, unknown>) => { lines.push(logged); } }) });
    await h.registerProject();
    const run = await runningSetup(h);
    const stored = await appendSetupJournal({ store: h.store, now: () => h.clock.now }, { orgId: IMPLICIT_COMPANY_ID, project: "payments", taskId: run.taskId }, [
      entry(1, "npm ci"), entry(2, "grep -rn pytest .", { exitCode: 1 }), entry(3, `npm test ${SETUP_SECRET_NEEDLE}`, { exitCode: 1, tail: "boom" }),
    ]);
    expect(stored.stored).toBe(3);
    h.clock.advance(SETUP_RUN_SILENT_MS / 1_000 + 1);
    expect(await h.flow.sweepRunsOnce()).toMatchObject({ interrupted: 1 });
    const ended = lines.filter((logged) => logged["event"] === "setup_run_ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ project: "payments", stop: "infrastructure", status: "failed", commandsRun: 3, passed: 1, nothingFound: 1, failed: 1, timedOut: 0, setupFound: 0, testsFound: 0, partial: true, companyId: IMPLICIT_COMPANY_ID });
    expect(JSON.stringify(ended[0])).not.toContain(SETUP_SECRET_NEEDLE);
    await h.flow.sweepRunsOnce();
    expect(lines.filter((logged) => logged["event"] === "setup_run_ended")).toHaveLength(1);
    // A repeat of the end itself (the worker's result arriving again) finds the result kept and writes no second line.
    const task = (await readTask(h.deps, run.taskId))!;
    expect(task.agentRunEnd).toBeDefined();
    await endSetupAgentTask(h.deps, task, { kind: "task", workflowMode: "SETUP_AGENT" } as never, { status: "SUCCEEDED" });
    await endSetupAgentTask(h.deps, task, { kind: "task", workflowMode: "SETUP_AGENT" } as never, { status: "SUCCEEDED" });
    expect(lines.filter((logged) => logged["event"] === "setup_run_ended")).toHaveLength(1);
  });
});
