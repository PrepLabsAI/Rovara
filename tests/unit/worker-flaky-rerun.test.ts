// TE-C6: a failing test of a task round's test check that passed before is rerun once. One that passes on the rerun is flaky (not sent to the agent, named in the evidence); one that fails again, or whose rerun did not run, stays a
// failure. Real report files in a real workspace and the real `runChecks`; only the command runners are fakes, and they write the reports a runner would.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FlakyRerunFileSchema, type CheckEntry, type ProjectCommand } from "../../packages/contracts/src/index.js";
import { runChecks, type CheckPlan, type CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { CHECKS_MESSAGE_TYPE, checksFeedback, verificationExtension, type VerificationOptions } from "../../packages/worker/src/verification/extension.js";
import { FLAKY_RERUN_IDS_MAX, flakyRerunFileFor, flakyRerunFileOf, rerunFlaky, type FlakyRerunResult } from "../../packages/worker/src/verification/flaky-rerun.js";
import { splitFailures } from "../../packages/worker/src/nightly-run.js";
import { RunnerKillUnconfirmedError } from "../../packages/worker/src/collected-process.js";
import { WorkspaceSafety, withWorkspaceSafety } from "../../packages/worker/src/workspace-safety.js";

type State = "passed" | "failed" | "skipped";
const PYTEST_ARGS = ["--junitxml=report.xml"];
const pytest = (args: string[] = PYTEST_ARGS): ProjectCommand => ({ cwd: ".", executable: "pytest", args, timeoutSeconds: 600 });
const VITEST_ARGS = ["--reporter=json", "--outputFile=out.json"];
const vitest = (): ProjectCommand => ({ cwd: ".", executable: "vitest", args: VITEST_ARGS, timeoutSeconds: 600 });
const TESTS = { kind: "test", selectArgs: ["{tests}"] } as const;
const MINUTE = 60_000;

/** A pytest JUnit report whose cases name their file, so the ids are `tests/test_cart.py::test_total`. */
function junit(states: Record<string, State>): string {
  const cases = Object.entries(states).map(([id, state]) => {
    const [file, name] = id.split("::") as [string, string];
    const inner = state === "failed" ? '<failure message="assert 1 == 2">boom</failure>' : state === "skipped" ? '<skipped message="s"/>' : "";
    return `<testcase classname="${file.replace(/\.py$/u, "").replaceAll("/", ".")}" name="${name}" file="${file}" time="0.01">${inner}</testcase>`;
  });
  return `<?xml version="1.0"?><testsuites><testsuite name="pytest" tests="${cases.length}">${cases.join("")}</testsuite></testsuites>`;
}

/** A vitest JSON report: one result per file. */
function vitestJson(states: Record<string, State>): string {
  const byFile = new Map<string, Array<{ fullName: string; status: string }>>();
  for (const [id, state] of Object.entries(states)) {
    const [file, name] = id.split("::") as [string, string];
    byFile.set(file, [...(byFile.get(file) ?? []), { fullName: name, status: state }]);
  }
  return JSON.stringify({ testResults: [...byFile].map(([name, assertionResults]) => ({ name: join(root, name), status: assertionResults.some((entry) => entry.status === "failed") ? "failed" : "passed", assertionResults })) });
}

type Script = Array<Record<string, State> | "no_report" | "unreadable" | "timeout" | "timeout_after_report" | "passed_exit_1" | "hang">;
interface World {
  /** The first run's report, then each rerun's, in order; the last repeats. */
  runs: Script;
  /** Writes the report in this format. */
  format?: "junit" | "json";
  /** Called before each run (the index starts at 0 for the round's own run). */
  before?: (index: number) => void;
  /** The exit code of rerun number n (0 = the first rerun), overriding the one the report implies. */
  exitOnRerun?: number[];
}

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "flaky-rerun-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function worldRunners(world: World) {
  const calls: ProjectCommand[] = [];
  const runners: CheckRunners = {
    async runProjectCommand(command, signal) {
      const index = calls.length;
      calls.push(command);
      world.before?.(index);
      const step = world.runs[Math.min(index, world.runs.length - 1)]!;
      if (step === "hang") {
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        return { exitCode: null, timedOut: false, stdout: "", stderr: "" };
      }
      if (step === "timeout") return { exitCode: null, timedOut: true, stdout: "", stderr: "" };
      const path = join(root, command.args.some((arg) => arg.includes("out.json")) ? "out.json" : "report.xml");
      if (step === "unreadable") await writeFile(path, "<testsuite><testcase name=");
      else if (step === "timeout_after_report" || step === "passed_exit_1") await writeFile(path, junit({ [ID_TOTAL]: "passed" }));
      else if (step !== "no_report") await writeFile(path, world.format === "json" ? vitestJson(step) : junit(step));
      if (step === "timeout_after_report") return { exitCode: null, timedOut: true, stdout: "", stderr: "" };
      if (step === "passed_exit_1") return { exitCode: 1, timedOut: false, stdout: "coverage 71% is below the 80% gate", stderr: "" };
      const failed = step !== "no_report" && step !== "unreadable" && Object.values(step).includes("failed");
      const forced = index > 0 ? world.exitOnRerun?.[index - 1] : undefined;
      return { exitCode: forced ?? (failed ? 1 : 0), timedOut: false, stdout: "", stderr: "" };
    },
    async runAgentCommand() { throw new Error("no agent commands here"); },
  };
  return { runners, calls };
}

/** The round itself (the real `runChecks`), then everything `rerunFlaky` needs. */
async function afterRound(world: World, options: { command?: ProjectCommand; checks?: Array<{ kind: string; selectArgs?: readonly string[] }>; signal?: AbortSignal; budgetMs?: number } = {}) {
  const { runners, calls } = worldRunners(world);
  const command = options.command ?? pytest();
  const signal = options.signal ?? new AbortController().signal;
  const started = Date.now() - 50;
  const plan: CheckPlan = { source: "project", readiness: [command], projectBefore: ["passed"] };
  const round = await runChecks(plan, runners, { budgetMs: 30 * MINUTE, signal });
  const rerun = () => rerunFlaky({ rootPath: root, commands: [command], checks: options.checks ?? [TESTS], entries: round.entries, runners, roundStartedAtMs: started, budgetMs: options.budgetMs ?? 30 * MINUTE, signal });
  return { round, rerun, calls, runners };
}

const FIRST = { "tests/test_cart.py::test_total": "failed", "tests/test_cart.py::test_tax": "passed" } as const;
const ID_TOTAL = "tests/test_cart.py::test_total";
const ID_TAX = "tests/test_cart.py::test_tax";

describe("a rerun that did not run leaves the failure a failure", () => {

  it("a vitest check with two files: the file whose command exited 0 is flaky, the one that exited 1 is not, so the check is not fully flaky", async () => {
    const first = { "a.test.ts::adds": "failed", "b.test.ts::subtracts": "failed" } as const;
    const { rerun } = await afterRound({ format: "json", runs: [first, { "a.test.ts::adds": "passed" }, { "b.test.ts::subtracts": "passed" }], exitOnRerun: [0, 1] }, { command: vitest() });
    const result = (await rerun()).get("readiness:0");
    expect(result).toEqual({ checkId: "readiness:0", flaky: ["a.test.ts::adds"], failing: ["b.test.ts::subtracts"] });
  });

  it("a rerun that writes no report, or one that cannot be read", async () => {
    for (const step of ["no_report", "unreadable"] as const) {
      const { rerun } = await afterRound({ runs: [FIRST, step] });
      const entry = (await rerun()).get("readiness:0");
      expect(entry, step).toEqual({ checkId: "readiness:0", flaky: [], failing: [ID_TOTAL] });
    }
  });

  it("a test the rerun report leaves out, and a test that was skipped on the rerun, are still failing", async () => {
    const both = { [ID_TOTAL]: "failed", [ID_TAX]: "failed" } as const;
    const left = await afterRound({ runs: [both, { "tests/test_cart.py::test_other": "passed" }] });
    expect((await left.rerun()).get("readiness:0")).toEqual({ checkId: "readiness:0", flaky: [], failing: [ID_TAX, ID_TOTAL] });
    const skipped = await afterRound({ runs: [FIRST, { [ID_TOTAL]: "skipped" }] });
    expect((await skipped.rerun()).get("readiness:0")).toEqual({ checkId: "readiness:0", flaky: [], failing: [ID_TOTAL] });
  });

  it("no budget left: nothing is rerun, no command starts", async () => {
    const { rerun, calls } = await afterRound({ runs: [FIRST, { [ID_TOTAL]: "passed" }] }, { budgetMs: 999 });
    expect((await rerun()).size).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("an abort stops the rerun at once, leaves nothing flaky, and the report is back as it was", async () => {
    const controller = new AbortController();
    const { rerun, calls } = await afterRound({ runs: [FIRST, "hang"] }, { signal: controller.signal });
    const firstReport = await readFile(join(root, "report.xml"), "utf8");
    const running = rerun();
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    expect((await running).size).toBe(0);
    expect(calls).toHaveLength(2);
    expect(await readFile(join(root, "report.xml"), "utf8")).toBe(firstReport);
  });

  it("an already-aborted round reruns nothing", async () => {
    const controller = new AbortController();
    const { round, runners, calls } = await afterRound({ runs: [FIRST, { [ID_TOTAL]: "passed" }] });
    controller.abort();
    const aborted = await rerunFlaky({ rootPath: root, commands: [pytest()], checks: [TESTS], entries: round.entries, runners, roundStartedAtMs: 0, budgetMs: MINUTE, signal: controller.signal });
    expect(aborted.size).toBe(0);
    expect(calls).toHaveLength(1);
  });
});

describe("an unsafe workspace is not written again, and a multi-repo round is not rerun", () => {
  /** Three pytest checks, each failing one test next to a passing one, each with its own report file. A rerun of check `unsafeOn` (0-based) writes its narrower report and then cannot confirm its stop. */
  async function threeChecks(unsafeOn: number | undefined, extra: Partial<CheckRunners> = {}) {
    const commands = [0, 1, 2].map((n) => pytest([`--junitxml=report${n}.xml`, `check${n}`]));
    const calls: ProjectCommand[] = [];
    const runners: CheckRunners = {
      async runProjectCommand(command) {
        calls.push(command);
        const n = Number(/report(\d)\.xml/u.exec(command.args.join(" "))![1]);
        const rerun = command.args.some((arg) => arg.includes("::"));
        const id = `tests/test_${n}.py::test_x`;
        const states: Record<string, State> = rerun ? { [id]: "passed" } : { [id]: "failed", [`tests/test_${n}.py::test_other`]: "passed" };
        await writeFile(join(root, `report${n}.xml`), junit(states));
        if (rerun && n === unsafeOn) throw new RunnerKillUnconfirmedError({ kind: "local" });
        return { exitCode: rerun ? 0 : 1, timedOut: false, stdout: "", stderr: "" };
      },
      async runAgentCommand() { throw new Error("no agent commands here"); },
      ...extra,
    };
    const started = Date.now() - 50;
    const signal = new AbortController().signal;
    const round = await runChecks({ source: "project", readiness: commands, projectBefore: ["passed", "passed", "passed"] }, runners, { budgetMs: 30 * MINUTE, signal });
    const rerun = () => rerunFlaky({ rootPath: root, commands, checks: [TESTS, TESTS, TESTS], entries: round.entries, runners, roundStartedAtMs: started, budgetMs: 30 * MINUTE, signal });
    const report = (n: number) => readFile(join(root, `report${n}.xml`), "utf8");
    return { rerun, calls, report };
  }

  it("a rerun stopped without confirmation ends the whole rerun: no result at all, no later check is rerun, and no report is written back", async () => {
    await withWorkspaceSafety(new WorkspaceSafety(), async () => {
      const { rerun, calls, report } = await threeChecks(1);
      const result = await rerun();
      // The three round runs, the first check's rerun, the second check's rerun (which could not be confirmed stopped): the third is never rerun.
      expect(calls).toHaveLength(5);
      expect(result.size).toBe(0);
      // The second check's report stays as the stopped rerun left it: an unsafe workspace is not written again (the first check's was put back before anything was unsafe).
      expect(await report(1)).not.toContain("test_other");
      expect(await report(0)).toContain("test_other");
    });
  });

  it("a multi-repo round (runners with a report root of their own) is not rerun: no command starts", async () => {
    const { rerun, calls } = await threeChecks(undefined, { reportRoot: () => root });
    expect((await rerun()).size).toBe(0);
    expect(calls).toHaveLength(3);
  });
});

describe("what is never rerun", () => {
  it("a check with no approved template, a runner whose syntax is not known, or a check that is not a test check", async () => {
    const noTemplate = await afterRound({ runs: [FIRST, { [ID_TOTAL]: "passed" }] }, { checks: [{ kind: "test" }] });
    expect((await noTemplate.rerun()).size).toBe(0);
    expect(noTemplate.calls).toHaveLength(1);
    const lint = await afterRound({ runs: [FIRST, { [ID_TOTAL]: "passed" }] }, { checks: [{ kind: "lint", selectArgs: ["{tests}"] }] });
    expect((await lint.rerun()).size).toBe(0);
    const unknown = await afterRound({ runs: [FIRST, { [ID_TOTAL]: "passed" }] }, { command: { cwd: ".", executable: "npm", args: ["test", "--", ...PYTEST_ARGS], timeoutSeconds: 600 } });
    expect((await unknown.rerun()).size).toBe(0);
    expect(unknown.calls).toHaveLength(1);
  });

  it("a check the agent ran itself, and a check that did not regress, are not rerun", async () => {
    const { round, runners, calls } = await afterRound({ runs: [FIRST, { [ID_TOTAL]: "passed" }] });
    const own: CheckEntry = { ...round.entries[0]!, source: "agent_commands" };
    const notRegression: CheckEntry = { ...round.entries[0]!, class: "already_failing" };
    for (const entries of [[own], [notRegression]]) {
      expect((await rerunFlaky({ rootPath: root, commands: [pytest()], checks: [TESTS], entries, runners, roundStartedAtMs: 0, budgetMs: MINUTE, signal: new AbortController().signal })).size).toBe(0);
    }
    expect(calls).toHaveLength(1);
  });

  it("more failing tests than the cap are a regression, not bad luck: no rerun", async () => {
    const many = Object.fromEntries(Array.from({ length: FLAKY_RERUN_IDS_MAX + 1 }, (_, index) => [`tests/test_many.py::test_${String(index)}`, "failed" as const]));
    const { rerun, calls } = await afterRound({ runs: [many, many] });
    expect((await rerun()).size).toBe(0);
    expect(calls).toHaveLength(1);
  });

});

describe("splitFailures is the nightly's own", () => {
  it("is shared by the nightly run and the task round, and reads the same", () => {
    expect(splitFailures(["a", "b", "b"], ["b"])).toEqual({ failed: ["b"], flaky: ["a"] });
  });
});

// ---- the extension: the extra turn and what the agent reads

/** Loads the extension into the fake Pi (an inline extension is a name and a factory). */
function install(extension: unknown, pi: unknown): void {
  (extension as { factory: (pi: unknown) => void }).factory(pi);
}

function fakePi() {
  const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
  return { pi: { on: (name: string, handler: (event: unknown, context: unknown) => unknown) => { handlers.set(name, handler); } }, settle: () => handlers.get("agent_before_settle")!({ outcome: "completed", entries: [] }, { signal: new AbortController().signal }) as Promise<{ continue?: boolean; entries?: Array<{ customType?: string; content?: string }> }> };
}

async function settle(world: World, options: { flaky?: boolean; commands?: ProjectCommand[]; checks?: Array<{ kind: string; selectArgs?: readonly string[] }>; second?: boolean; budgetMs?: number } = {}) {
  const { runners, calls } = worldRunners(world);
  const commands = options.commands ?? [pytest()];
  const reports: Array<{ status: string; extraTry: string; checks: CheckEntry[] }> = [];
  const extension = verificationExtension({
    plan: () => ({ source: "project", readiness: commands, projectBefore: commands.map(() => "passed" as const) }),
    runners, budgetMs: () => options.budgetMs ?? 30 * MINUTE, signal: new AbortController().signal,
    recorder: { settled: async () => undefined, observeCall: async () => undefined, observe: () => undefined, observeExecutionEnd: () => undefined, observeTurnEnd: () => undefined } as unknown as VerificationOptions["recorder"],
    onReport: (report) => { reports.push(report); },
    ...(options.flaky === false ? {} : { flakyRerun: { rootPath: root, checks: options.checks ?? [TESTS] } }),
  });
  const pi = fakePi();
  install(extension, pi.pi);
  const first = await pi.settle();
  const secondResult = options.second === true ? await pi.settle() : undefined;
  return { first, second: secondResult, reports, calls };
}

describe("the extra turn", () => {
  it("a regression whose every failing test passed on the rerun gives the agent no extra turn, and the report still says regression", async () => {
    const { first, reports, calls } = await settle({ runs: [FIRST, { [ID_TOTAL]: "passed" }] });
    expect(first.continue).toBeUndefined();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ status: "regression", extraTry: "not_needed" });
    expect(reports[0]?.checks[0]).toMatchObject({ class: "regression", after: "failed", before: "passed" });
    expect(calls).toHaveLength(2);
  });

  it("control run: a test that fails on every run still gives the extra turn, with the check in what the agent reads", async () => {
    const { first, reports, calls } = await settle({ runs: [FIRST, { [ID_TOTAL]: "failed" }] });
    expect(first.continue).toBe(true);
    expect(reports).toHaveLength(0);
    const message = first.entries?.at(-1);
    expect(message?.customType).toBe(CHECKS_MESSAGE_TYPE);
    expect(message?.content).toContain("This is a regression.");
    expect(calls).toHaveLength(2);
  });

});

describe("what the agent reads", () => {
  const failing: CheckEntry = { id: "readiness:0", label: "pytest -q", source: "project", before: "passed", after: "failed", class: "regression", output: "FAILED tests/test_cart.py::test_total", durationMs: 5, exitCode: 1 };

  it("is today's text, word for word, when nothing is left out", () => {
    expect(checksFeedback([failing])).toBe([
      "AgentX reran the checks when you finished, and found a regression: a check that passed before your change fails now.",
      "You have one more turn. Fix the regression, run the check again, and then finish. AgentX reruns the checks once more after this turn.",
      "If a failing test checks the old behaviour the task asked you to change, it is not a regression: leave the test as it is and name it in your final message. Never edit or delete a test to make it pass, unless the task explicitly asks you to change tests.",
      "End your final message with the AgentX result line, as before.",
      "",
      "Check: pytest -q",
      "Before your change: passed. Now: failed. This is a regression.",
      "Output (last lines):",
      "FAILED tests/test_cart.py::test_total",
    ].join("\n"));
  });

});

describe("the file the worker saves for the broker", () => {
  const result = (...rows: Array<{ checkId: string; flaky: string[]; failing: string[] }>): FlakyRerunResult => new Map(rows.map((row) => [row.checkId, row]));

  it("names only the checks that are fully flaky, in the contract's shape", () => {
    const file = flakyRerunFileOf(result({ checkId: "readiness:0", flaky: [ID_TOTAL], failing: [] }, { checkId: "readiness:1", flaky: [ID_TAX], failing: [ID_TOTAL] }));
    expect(file?.name).toBe("flaky-rerun.json");
    expect(FlakyRerunFileSchema.parse(JSON.parse(file!.content))).toEqual({ schemaVersion: 1, checks: [{ checkId: "readiness:0", flaky: [ID_TOTAL] }] });
  });

  it("is no file at all when no check is fully flaky (the broker then has nothing to excuse)", () => {
    expect(flakyRerunFileOf(undefined)).toBeUndefined();
    expect(flakyRerunFileOf(new Map())).toBeUndefined();
    expect(flakyRerunFileOf(result({ checkId: "readiness:0", flaky: [ID_TOTAL], failing: [ID_TAX] }))).toBeUndefined();
    expect(flakyRerunFileOf(result({ checkId: "readiness:0", flaky: [], failing: [] }))).toBeUndefined();
  });
});

describe("the file is only for the report it came with", () => {
  const held = (report: object): { report: object; result: FlakyRerunResult } => ({ report, result: new Map([["readiness:0", { checkId: "readiness:0", flaky: [ID_TOTAL], failing: [] }]]) });

  it("is saved for the report that stands, and for no other: a later round's report, a stop or an error is a different report", () => {
    const first = { status: "regression" };
    expect(flakyRerunFileFor(first, held(first))?.name).toBe("flaky-rerun.json");
    const later = { status: "regression" };
    expect(flakyRerunFileFor(later, held(first))).toBeUndefined();
    expect(flakyRerunFileFor(undefined, held(first))).toBeUndefined();
    expect(flakyRerunFileFor(first, undefined)).toBeUndefined();
  });
});
