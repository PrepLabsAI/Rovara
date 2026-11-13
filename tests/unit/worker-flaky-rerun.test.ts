// TE-C6: a failing test of a task round's test check that passed before is rerun once. One that passes on the rerun is flaky (not sent to the agent, named in the evidence); one that fails again, or whose rerun did not run, stays a
// failure. Real report files in a real workspace and the real `runChecks`; only the command runners are fakes, and they write the reports a runner would.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CheckEntry, ProjectCommand } from "../../packages/contracts/src/index.js";
import { runChecks, type CheckPlan, type CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { CHECKS_MESSAGE_TYPE, checksFeedback, verificationExtension, type VerificationOptions } from "../../packages/worker/src/verification/extension.js";
import { FLAKY_RERUN_IDS_MAX, isFullyFlaky, rerunFlaky } from "../../packages/worker/src/verification/flaky-rerun.js";
import { splitFailures } from "../../packages/worker/src/nightly-run.js";

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

type Script = Array<Record<string, State> | "no_report" | "unreadable" | "timeout" | "hang">;
interface World {
  /** The first run's report, then each rerun's, in order; the last repeats. */
  runs: Script;
  /** Writes the report in this format. */
  format?: "junit" | "json";
  /** Called before each run (the index starts at 0 for the round's own run). */
  before?: (index: number) => void;
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
      if (step === "hang") await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      if (step === "timeout") return { exitCode: null, timedOut: true, stdout: "", stderr: "" };
      const path = join(root, command.args.some((arg) => arg.includes("out.json")) ? "out.json" : "report.xml");
      if (step === "unreadable") await writeFile(path, "<testsuite><testcase name=");
      else if (step !== "no_report") await writeFile(path, world.format === "json" ? vitestJson(step) : junit(step));
      const failed = step !== "no_report" && step !== "unreadable" && Object.values(step).includes("failed");
      return { exitCode: failed ? 1 : 0, timedOut: false, stdout: "", stderr: "" };
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

describe("a failing test that passes on the rerun is flaky", () => {
  it("fail then pass: flaky, the check is fully flaky, and its entry is untouched (still a failed regression)", async () => {
    const { round, rerun, calls } = await afterRound({ runs: [FIRST, { [ID_TOTAL]: "passed" }] });
    const before = JSON.stringify(round.entries);
    expect(round.entries[0]).toMatchObject({ class: "regression", after: "failed" });
    const result = await rerun();
    expect(result.get("readiness:0")).toEqual({ checkId: "readiness:0", flaky: [ID_TOTAL], failing: [] });
    expect(isFullyFlaky(result.get("readiness:0"))).toBe(true);
    expect(JSON.stringify(round.entries)).toBe(before);
    // The rerun asked for exactly the failing test, as a separate argument, and nothing else.
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ executable: "pytest", args: [...PYTEST_ARGS, ID_TOTAL] });
  });

  it("puts the first report back: what the evidence reads after the rerun is the round's own report", async () => {
    const { rerun } = await afterRound({ runs: [FIRST, { [ID_TOTAL]: "passed" }] });
    const firstReport = await readFile(join(root, "report.xml"), "utf8");
    await rerun();
    expect(await readFile(join(root, "report.xml"), "utf8")).toBe(firstReport);
    expect(firstReport).toContain("test_tax");
  });

  it("control run: a test that fails every time stays failing, and the check is not flaky", async () => {
    const { rerun } = await afterRound({ runs: [FIRST, { [ID_TOTAL]: "failed" }] });
    const result = await rerun();
    expect(result.get("readiness:0")).toEqual({ checkId: "readiness:0", flaky: [], failing: [ID_TOTAL] });
    expect(isFullyFlaky(result.get("readiness:0"))).toBe(false);
  });

  it("mixed: one flaky and one failing again: the check is not fully flaky", async () => {
    const both = { [ID_TOTAL]: "failed", [ID_TAX]: "failed" } as const;
    const { rerun } = await afterRound({ runs: [both, { [ID_TOTAL]: "passed", [ID_TAX]: "failed" }] });
    const result = await rerun();
    expect(result.get("readiness:0")).toEqual({ checkId: "readiness:0", flaky: [ID_TOTAL], failing: [ID_TAX] });
    expect(isFullyFlaky(result.get("readiness:0"))).toBe(false);
  });

  it("a vitest check is rerun one file at a time, reading the report after each command", async () => {
    const first = { "a.test.ts::adds": "failed", "b.test.ts::subtracts": "failed", "b.test.ts::keeps": "passed" } as const;
    const { rerun, calls } = await afterRound({ format: "json", runs: [first, { "a.test.ts::adds": "passed" }, { "b.test.ts::subtracts": "passed" }] }, { command: vitest() });
    const result = await rerun();
    expect(result.get("readiness:0")).toEqual({ checkId: "readiness:0", flaky: ["a.test.ts::adds", "b.test.ts::subtracts"], failing: [] });
    expect(calls.slice(1).map((call) => call.args.slice(VITEST_ARGS.length))).toEqual([["a.test.ts", "-t", "^(?:adds)$"], ["b.test.ts", "-t", "^(?:subtracts)$"]]);
  });
});

describe("a rerun that did not run leaves the failure a failure", () => {
  it("a rerun that timed out", async () => {
    const { rerun } = await afterRound({ runs: [FIRST, "timeout"] });
    expect((await rerun()).get("readiness:0")).toEqual({ checkId: "readiness:0", flaky: [], failing: [ID_TOTAL] });
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

  it("test ids that could read as options are never passed: such a check is not rerun", async () => {
    for (const bad of ["-weird.py::test_x", "@weird.py::test_x"]) {
      const { rerun, calls } = await afterRound({ runs: [{ [bad]: "failed" }, { [bad]: "passed" }] });
      expect((await rerun()).size, bad).toBe(0);
      expect(calls, bad).toHaveLength(1);
    }
  });

  it("a report that shows no failing test is nothing to rerun", async () => {
    const { rerun, calls } = await afterRound({ runs: [{ [ID_TAX]: "failed" }, { [ID_TAX]: "passed" }] });
    // The check failed on its exit code but the report is rewritten with nothing failing before the rerun looks.
    await writeFile(join(root, "report.xml"), junit({ [ID_TAX]: "passed" }));
    expect((await rerun()).size).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("more failing tests than the cap are a regression, not bad luck: no rerun", async () => {
    const many = Object.fromEntries(Array.from({ length: FLAKY_RERUN_IDS_MAX + 1 }, (_, index) => [`tests/test_many.py::test_${String(index)}`, "failed" as const]));
    const { rerun, calls } = await afterRound({ runs: [many, many] });
    expect((await rerun()).size).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("exactly the cap is rerun, as one command", async () => {
    const many = Object.fromEntries(Array.from({ length: FLAKY_RERUN_IDS_MAX }, (_, index) => [`tests/test_many.py::test_${String(index)}`, "failed" as const]));
    const { rerun, calls } = await afterRound({ runs: [many, Object.fromEntries(Object.keys(many).map((id) => [id, "passed" as const]))] });
    const result = (await rerun()).get("readiness:0");
    expect(result?.flaky).toHaveLength(FLAKY_RERUN_IDS_MAX);
    expect(result?.failing).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("5,000 failing tests in a megabyte of report stay fast and make no rerun", async () => {
    const many = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`tests/test_${String(index % 50)}.py::test_${String(index)}`, "failed" as const]));
    const { rerun, calls } = await afterRound({ runs: [many] });
    const started = Date.now();
    expect((await rerun()).size).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(calls).toHaveLength(1);
  });
});

describe("splitFailures is the nightly's own", () => {
  it("is shared by the nightly run and the task round, and reads the same", () => {
    expect(splitFailures(["a", "b", "b"], ["b"])).toEqual({ failed: ["b"], flaky: ["a"] });
  });
});

// ---- the extension: the extra turn and what the agent reads

function fakePi() {
  const handlers = new Map<string, (event: unknown, context: unknown) => Promise<unknown> | unknown>();
  return { pi: { on: (name: string, handler: (event: unknown, context: unknown) => unknown) => { handlers.set(name, handler as never); } }, settle: () => handlers.get("agent_before_settle")!({ outcome: "completed", entries: [] }, { signal: new AbortController().signal }) as Promise<{ continue?: boolean; entries?: Array<{ customType?: string; content?: string }> }> };
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
  extension.factory(pi.pi as never);
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

  it("a rerun that timed out, wrote nothing or left the test out gives the extra turn", async () => {
    for (const step of ["timeout", "no_report", { "tests/test_cart.py::test_other": "passed" }] as const) {
      const { first } = await settle({ runs: [FIRST, step] });
      expect(first.continue, JSON.stringify(step)).toBe(true);
    }
  });

  it("with no plan flag there is no rerun, and the extra turn is given as it always was", async () => {
    const { first, calls } = await settle({ runs: [FIRST, { [ID_TOTAL]: "passed" }] }, { flaky: false });
    expect(first.continue).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("a check with no template, or the agent's own commands, gets no rerun", async () => {
    const { first, calls } = await settle({ runs: [FIRST, { [ID_TOTAL]: "passed" }] }, { checks: [{ kind: "test" }] });
    expect(first.continue).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("one flaky check and one that fails again: the extra turn is given and only the failing check is sent", async () => {
    // Two project checks: pytest writes report.xml and a second pytest writes report2.xml; each fails once, the first passes on rerun.
    const second = pytest(["--junitxml=report2.xml", "second"]);
    const calls: ProjectCommand[] = [];
    const runners: CheckRunners = {
      async runProjectCommand(command) {
        calls.push(command);
        const isSecond = command.args.includes("second");
        const rerun = command.args.some((arg) => arg.includes("::"));
        const states: Record<string, State> = isSecond ? { "tests/test_b.py::test_two": "failed" } : { [ID_TOTAL]: rerun ? "passed" : "failed" };
        await writeFile(join(root, isSecond ? "report2.xml" : "report.xml"), junit(states));
        return { exitCode: Object.values(states).includes("failed") ? 1 : 0, timedOut: false, stdout: "", stderr: "" };
      },
      async runAgentCommand() { throw new Error("no"); },
    };
    const extension = verificationExtension({
      plan: () => ({ source: "project", readiness: [pytest(), second], projectBefore: ["passed", "passed"] }), runners, budgetMs: () => 30 * MINUTE, signal: new AbortController().signal,
      recorder: { settled: async () => undefined, observeCall: async () => undefined, observe: () => undefined, observeExecutionEnd: () => undefined, observeTurnEnd: () => undefined } as unknown as VerificationOptions["recorder"],
      onReport: () => undefined, flakyRerun: { rootPath: root, checks: [TESTS, TESTS] },
    });
    const pi = fakePi();
    extension.factory(pi.pi as never);
    const result = await pi.settle();
    expect(result.continue).toBe(true);
    const text = result.entries?.at(-1)?.content ?? "";
    expect(text).toContain("second");
    expect(text).not.toContain(PYTEST_ARGS[0]!);
  });

  it("after the extra turn the second round does not rerun, and reports whatever it finds", async () => {
    const { reports, calls } = await settle({ runs: [FIRST, { [ID_TOTAL]: "failed" }, FIRST] }, { second: true });
    // Round one: the check, one rerun (still failing) -> extra turn. Round two: the check once, no rerun.
    expect(calls).toHaveLength(3);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ status: "regression", extraTry: "given" });
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

  it("leaves out a check that is fully flaky", () => {
    const other: CheckEntry = { ...failing, id: "readiness:1", label: "lint-ish", output: "kept" };
    const text = checksFeedback([failing, other], new Set(["readiness:0"]));
    expect(text).toContain("Check: lint-ish");
    expect(text).not.toContain("pytest -q");
    expect(text).not.toContain("test_total");
  });
});
