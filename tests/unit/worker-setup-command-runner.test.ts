// Setup run, "Run a command" (SH13), worker side: a person's command runs through the same shell the agent has (time limit, bounded redacted tail, tracked-file check), is journaled as a person's
// and does not use the agent's allowance, and the agent is told only the RESULT, as data inside a nonce tag.
import { describe, expect, it } from "vitest";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { SETUP_AGENT_LIMITS_DEFAULT, SetupJournalEntrySchema } from "../../packages/contracts/src/index.js";
import { SetupAgentGovernor } from "../../packages/worker/src/setup-agent-journal.js";
import { frameCommandResult, createPersonCommandRunner } from "../../packages/worker/src/setup-command-runner.js";
import { type TrackedFilesVerdict } from "../../packages/worker/src/setup-agent.js";

function harness(options: { exit?: number; output?: string; verdicts?: TrackedFilesVerdict[]; alive?: () => boolean; throws?: boolean } = {}) {
  const ran: Array<{ command: string; cwd: string; timeout: number | undefined }> = [];
  const told: string[] = [];
  const reports: Array<{ seq: number; journalN?: number; outcome: string }> = [];
  const ended: string[] = [];
  const stops: string[] = [];
  const governor = new SetupAgentGovernor({ limits: { ...SETUP_AGENT_LIMITS_DEFAULT, commands: 2 }, spendCents: () => 0, nextTurnCents: () => 0, onStop: (word) => stops.push(word) });
  const base: BashOperations = {
    async exec(command, cwd, opts) {
      ran.push({ command, cwd, timeout: opts.timeout });
      if (options.throws === true) throw new Error("boom");
      opts.onData(Buffer.from(options.output ?? "ok\n"));
      return { exitCode: options.exit ?? 0 };
    },
  };
  const verdicts = [...(options.verdicts ?? [])];
  const runner = createPersonCommandRunner({
    base, cwd: "/work", record: (record) => governor.recordPersonCommand(record), alive: options.alive ?? (() => true),
    checkFiles: async () => verdicts.shift() ?? { ok: true }, onEnded: (word) => { ended.push(word); governor.onEnded(word); },
    tellAgent: async (text) => { told.push(text); return true; }, report: async (done) => { reports.push(done); }, nonce: () => "n0nce",
  });
  return { runner, governor, ran, told, reports, ended, stops };
}

describe("a person's command", () => {
  it("runs in the sandbox, is journaled as a person's, and is reported with its journal position", async () => {
    const h = harness({ output: "installed 3 packages\n" });
    await h.runner.run({ seq: 1, command: "npm ls" });
    expect(h.ran).toEqual([{ command: "npm ls", cwd: "/work", timeout: 1800 }]);
    const entry = h.governor.entries()[0]!;
    expect(SetupJournalEntrySchema.safeParse(entry).success).toBe(true);
    expect(entry).toMatchObject({ n: 1, source: "person", command: "npm ls", exitCode: 0, tail: "installed 3 packages\n" });
    expect(h.reports).toEqual([{ seq: 1, journalN: 1, outcome: "ran" }]);
  });

  it("is never run once the run is over, and says so (nothing journaled)", async () => {
    const h = harness({ alive: () => false });
    await h.runner.run({ seq: 1, command: "ls" });
    expect(h.ran).toEqual([]);
    expect(h.governor.entries()).toEqual([]);
    expect(h.reports).toEqual([{ seq: 1, outcome: "not_run" }]);
    expect(h.told).toEqual([]);
  });

  it("a failure to run is reported as not_run and the next command still goes", async () => {
    const h = harness({ throws: true });
    await h.runner.run({ seq: 1, command: "ls" });
    expect(h.reports[0]).toMatchObject({ seq: 1 });
    expect(h.governor.entries()).toHaveLength(1);
    await h.runner.run({ seq: 2, command: "ls" });
    expect(h.reports).toHaveLength(2);
  });

});

describe("what the agent is told", () => {

  it("says a timeout, an unfinished command and a download-and-run command in fixed words", () => {
    const base = { n: 1, command: "x", durationMs: 2000, tail: "", flagged: false };
    expect(frameCommandResult({ ...base, exitCode: null, timedOut: true }, "n")).toContain("timed out after 2 s");
    expect(frameCommandResult({ ...base, exitCode: null, timedOut: false }, "n")).toContain("did not finish");
    expect(frameCommandResult({ ...base, exitCode: 0, timedOut: false, flagged: true }, "n")).toContain("(it downloads code and runs it)");
  });
});

