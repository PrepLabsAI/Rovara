import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { proveWithMachineMeasurement } from "../../packages/worker/src/machine-measurement.js";
import { TestEnvProveReportSchema, TEST_ENV_PROVE_MEASURE_FEATURE } from "@agentx/contracts";
// Proof and test environment E3: the Prove run's sequence, failure words, bounds, and the report the broker re-reads.
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, testEnvDigest, testEnvIsProved, type ProjectCommand, type TestEnvironmentBody } from "@agentx/contracts";
import { RunnerKillUnconfirmedError } from "../../packages/worker/src/collected-process.js";
import { proveEnvironment, type ProveCommandResult, type ProvePorts } from "../../packages/worker/src/prove.js";

const sha = (letter: string) => letter.repeat(64);
const cmd = (executable: string, args: string[] = []) => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const env = (over: Record<string, unknown> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "svc", setupCommands: [cmd("pip", ["install"])], checks: [
    { id: "build", label: "Build", command: cmd("make", ["build"]), kind: "build" },
    { id: "smoke", label: "Smoke", command: cmd("pytest", ["smoke"]), kind: "smoke" },
    { id: "unit", label: "Unit", command: cmd("pytest", ["-q"]), kind: "test" },
  ] }],
  roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: true, cronUtc: "0 6 * * *", branch: "main" },
  services: [{ name: "scorer", kind: "sagemaker_runtime", match: { endpointName: "scorer" }, mode: "mock", mock: { fixtureSetRef: sha("a"), schemaRef: sha("b"), unmatched: "fail" } }],
  data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, ...over,
});
const preprodAuto = () => env({ services: [{ name: "scorer", kind: "sagemaker_runtime", match: { endpointName: "scorer" }, mode: "auto",
  preprod: { endpointArn: "arn:aws:sagemaker:us-west-2:123456789012:endpoint/scorer", roleArn: "arn:aws:iam::123456789012:role/r", region: "us-west-2" }, mock: { fixtureSetRef: sha("a"), schemaRef: sha("b"), unmatched: "fail" } }] });
const preprodOnly = () => env({ services: [{ name: "scorer", kind: "sagemaker_runtime", match: { endpointName: "scorer" }, mode: "preprod",
  preprod: { endpointArn: "arn:aws:sagemaker:us-west-2:123456789012:endpoint/scorer", roleArn: "arn:aws:iam::123456789012:role/r", region: "us-west-2" } }] });

function fakes(over: Partial<ProvePorts> & { results?: Record<string, Partial<ProveCommandResult>> } = {}) {
  const clock = { t: 1_000_000 };
  const ran: string[] = [];
  const started: string[] = [];
  const ports: ProvePorts = {
    runCommand: (command: ProjectCommand) => {
      const key = `${command.executable} ${command.args.join(" ")}`.trim();
      ran.push(key);
      clock.t += key === "pytest -q" ? 90_000 : 1_000;
      return Promise.resolve({ exitCode: 0, timedOut: false, stdout: "", stderr: "", ...(over.results?.[key] ?? {}) });
    },
    startMock: (service) => { started.push(service.name); return Promise.resolve(); },
    probePreprod: () => Promise.resolve(true),
    mockUnmatched: () => Promise.resolve([{ service: "scorer", unmatchedFailed: 0 }]),
    buildCoverageMap: () => Promise.resolve(sha("c")),
    suiteTestCount: () => Promise.resolve(1_240),
    now: () => clock.t,
    ...over,
  };
  return { ports, ran, started, clock };
}
const prove = (ports: ProvePorts, environment = env(), signal = new AbortController().signal, deadlineMs = 3_600_000) => proveEnvironment(ports, { proposalDigest: testEnvDigest(environment), environment, signal, deadlineMs });
const statuses = (report: Awaited<ReturnType<typeof prove>>) => Object.fromEntries(report.steps.map((step) => [step.step, step.status]));

describe("a command whose stop could not be confirmed (FIX-RUNNER-ABORT-JOIN)", () => {
  it("is not an 'infrastructure' failure to step past: the run rejects with it, and runs no later step", async () => {
    const ran: string[] = [];
    const { ports } = fakes({ runCommand: (command: ProjectCommand) => { ran.push(command.executable); return Promise.reject(new RunnerKillUnconfirmedError({ kind: "local", pgid: 1 })); } });
    await expect(prove(ports)).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
    expect(ran).toEqual(["pip"]);
  });
});

describe("a passing run", () => {
  it("runs the steps in order, times the full suite, records the mode used and the coverage map, and is proved", async () => {
    const { ports, ran, started } = fakes();
    const environment = env();
    const report = await prove(ports, environment);
    expect(ran).toEqual(["pip install", "make build", "pytest smoke", "pytest -q"]);
    expect(started).toEqual(["scorer"]);
    expect(statuses(report)).toEqual({ setup: "passed", build: "passed", boot: "passed", smoke: "passed", full_suite: "passed", mocks: "passed", preprod_probe: "skipped" });
    expect(report.fullSuite).toEqual({ durationMs: 90_000, tests: 1_240 });
    expect(report.coverageMapRef).toBe(sha("c"));
    expect(report.services).toEqual([{ name: "scorer", modeUsed: "mocked" }]);
    expect(testEnvIsProved(report, testEnvDigest(environment), environment)).toBe(true);
  });
  it("a suite longer than the round budget is a result, not a failure (that is why selection exists)", async () => {
    const { ports, clock } = fakes();
    const slow: ProvePorts = { ...ports, runCommand: (command) => { clock.t += command.args.includes("-q") ? 45 * 60_000 : 1_000; return Promise.resolve({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }); } };
    const report = await prove(slow);
    expect(report.fullSuite?.durationMs).toBe(45 * 60_000);
    expect(statuses(report).full_suite).toBe("passed");
  });
  it("asks for no coverage map unless the environment selects by one, and a map that cannot be built is just absent", async () => {
    let asked = 0;
    const { ports } = fakes({ buildCoverageMap: () => { asked += 1; return Promise.reject(new Error("unreadable")); } });
    const none = await prove(ports, env({ selection: { method: "full", alwaysRun: [], fullSuiteOn: [] } }));
    expect(asked).toBe(0);
    expect(none.coverageMapRef).toBeUndefined();
    const failedMap = await prove(ports);
    expect(asked).toBe(1);
    expect(failedMap.coverageMapRef).toBeUndefined();
    expect(statuses(failedMap).full_suite).toBe("passed");
  });
});

describe("a failing step ends the run and names itself in fixed words", () => {
  const cases: Array<[string, string, string, string]> = [
    ["setup", "pip install", "setup", "setup_failed"],
    ["build", "make build", "build", "build_failed"],
    ["smoke", "pytest smoke", "smoke", "smoke_failed"],
    ["full suite", "pytest -q", "full_suite", "tests_failed"],
  ];
  it.each(cases)("%s", async (_name, key, step, failure) => {
    const { ports, ran } = fakes({ results: { [key]: { exitCode: 1, stdout: "collecting\nFAILED test_x", stderr: "boom" } } });
    const report = await prove(ports);
    const failed = report.steps.find((item) => item.status === "failed")!;
    expect(failed).toMatchObject({ step, failure });
    expect(failed.outputTail).toContain("FAILED test_x");
    const after = report.steps.slice(report.steps.indexOf(failed) + 1);
    expect(after.every((item) => item.status === "skipped")).toBe(true);
    expect(ran.length).toBeLessThanOrEqual(4);
    expect(testEnvIsProved(report, report.proposalDigest, {})).toBe(false);
    if (step !== "full_suite") expect(ran).not.toContain("pytest -q");
  });
  it("a command that hits its own time limit", async () => {
    const { ports } = fakes({ results: { "pytest -q": { exitCode: null, timedOut: true } } });
    expect(statuses(await prove(ports)).full_suite).toBe("failed");
    expect((await prove(ports)).steps.find((step) => step.step === "full_suite")?.failure).toBe("round_budget_exceeded");
  });
  it("redacts and bounds the tail of what the command printed, and keeps it plain text", async () => {
    const secret = `ghp_${"Ab1Cd2Ef3Gh4".repeat(3)}`;
    const { ports } = fakes({ results: { "make build": { exitCode: 2, stdout: `${"x".repeat(9_000)}\u0007\u001b[31mtoken ${secret}`, stderr: "" } } });
    const tail = (await prove(ports)).steps.find((step) => step.step === "build")?.outputTail ?? "";
    expect(tail.length).toBeLessThanOrEqual(4_096);
    expect(tail).not.toContain(secret);
    expect(/[\p{Cc}]/u.test(tail.replace(/[\n\t]/gu, ""))).toBe(false);
  });
  it("a mock that was asked for something unrecorded fails the run after the suite", async () => {
    const { ports } = fakes({ mockUnmatched: () => Promise.resolve([{ service: "scorer", unmatchedFailed: 3 }]) });
    const report = await prove(ports);
    expect(report.steps.find((step) => step.step === "mocks")).toMatchObject({ status: "failed", failure: "mock_unmatched" });
  });
  it("a mock that will not start, and a port that throws", async () => {
    const down = await prove(fakes({ startMock: () => Promise.reject(new Error("port in use")) }).ports);
    expect(down.steps.find((step) => step.step === "boot")).toMatchObject({ status: "failed", failure: "boot_failed" });
    expect(statuses(down).smoke).toBe("skipped");
    const thrown = await prove(fakes({ runCommand: () => Promise.reject(new Error("container gone")) }).ports);
    expect(thrown.steps.find((step) => step.step === "setup")).toMatchObject({ status: "failed", failure: "infrastructure" });
    expect(JSON.stringify(thrown)).not.toContain("container gone");
  });
});

describe("pre-prod", () => {
  it("in preprod mode an unreachable service fails the run, and a reachable one is reported as pre-prod", async () => {
    const environment = preprodOnly();
    const unreachable = await prove(fakes({ probePreprod: () => Promise.resolve(false) }).ports, environment);
    expect(unreachable.steps.find((step) => step.step === "preprod_probe")).toMatchObject({ status: "failed", failure: "preprod_unreachable" });
    const reachable = await prove(fakes().ports, environment);
    expect(reachable.services).toEqual([{ name: "scorer", modeUsed: "preprod" }]);
    expect(statuses(reachable).mocks).toBe("skipped");
    expect(testEnvIsProved(reachable, reachable.proposalDigest, {})).toBe(true);
  });
  it("in auto mode an unreachable service falls back to the mock and says so; a reachable one uses pre-prod", async () => {
    const environment = preprodAuto();
    const fallback = fakes({ probePreprod: () => Promise.resolve(false) });
    const report = await prove(fallback.ports, environment);
    expect(report.services).toEqual([{ name: "scorer", modeUsed: "mocked" }]);
    expect(fallback.started).toEqual(["scorer"]);
    expect(statuses(report)).toMatchObject({ preprod_probe: "passed", boot: "passed", mocks: "passed" });
    const direct = fakes();
    expect((await prove(direct.ports, environment)).services).toEqual([{ name: "scorer", modeUsed: "preprod" }]);
    expect(direct.started).toEqual([]);
  });
});

describe("bounds", () => {
  it("stops at the deadline and at a stop signal, failing the step in progress as infrastructure and running nothing after", async () => {
    const controller = new AbortController();
    const slow = fakes({ runCommand: (_command, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")))) });
    const running = prove(slow.ports, env(), controller.signal, 3_600_000);
    controller.abort();
    const report = await running;
    expect(report.steps.find((step) => step.status === "failed")).toMatchObject({ step: "setup", failure: "infrastructure" });
    const timed = await prove(slow.ports, env(), new AbortController().signal, 10);
    expect(timed.steps.find((step) => step.status === "failed")?.failure).toBe("infrastructure");
    const already = new AbortController();
    already.abort();
    expect((await prove(fakes().ports, env(), already.signal)).steps.find((step) => step.status === "failed")?.failure).toBe("infrastructure");
  });
  it("an environment with nothing to run is never proved", async () => {
    const empty = env({ repos: [{ repositoryId: "svc", setupCommands: [], checks: [] }], services: [] });
    const report = await prove(fakes().ports, empty);
    expect(Object.values(statuses(report)).every((status) => status === "skipped")).toBe(true);
    expect(testEnvIsProved(report, report.proposalDigest, {})).toBe(false);
  });
  it("refuses to label a run with a digest that is not the environment's", async () => {
    const environment = env();
    await expect(proveEnvironment(fakes().ports, { proposalDigest: sha("0"), environment, signal: new AbortController().signal, deadlineMs: 1000 })).rejects.toThrow(RangeError);
  });
  it("binds the report to the digest it was given", async () => {
    const report = await prove(fakes().ports);
    expect(testEnvIsProved(report, sha("0"), {})).toBe(false);
  });
});

describe("asked-for machine measurement", () => {
  it("gate off is byte-for-byte unchanged and never reads the port", async () => {
    const before = await prove(fakes().ports); let reads = 0;
    const ports = fakes({ peakMemory: async () => { reads++; return 6144; } }).ports;
    const environment = env();
    const after = await proveEnvironment(ports, { proposalDigest: testEnvDigest(environment), environment, signal: new AbortController().signal, deadlineMs: 3600000, machineChip: "arm64", measureMachine: false });
    expect(JSON.stringify(after)).toBe(JSON.stringify(before)); expect(reads).toBe(0);
  });
  it("adds facts only when asked, after the suite and before release", async () => {
    const { ports, ran } = fakes(); let released = false;
    ports.release = async () => { released = true; };
    ports.peakMemory = async () => { expect(ran).toContain("pytest -q"); expect(released).toBe(false); return 6144; };
    const environment = env();
    const report = await proveEnvironment(ports, { proposalDigest: testEnvDigest(environment), environment, signal: new AbortController().signal, deadlineMs: 3600000, machineChip: "arm64", measureMachine: true });
    expect(report.fullSuite?.peakMemoryMiB).toBe(6144); expect(report.machineChip).toBe("arm64");
  });
  it.each([undefined, NaN, Infinity, -1, 1_048_577])("omits invalid measurement %s", async peak => {
    const environment = env(); const report = await proveEnvironment(fakes({ peakMemory: async () => peak }).ports, { proposalDigest: testEnvDigest(environment), environment, signal: new AbortController().signal, deadlineMs: 3600000, measureMachine: true });
    expect(report.fullSuite).not.toHaveProperty("peakMemoryMiB");
  });
  it("a rejected reader does not fail the suite", async () => {
    const environment = env(); const report = await proveEnvironment(fakes({ peakMemory: async () => { throw new Error("unreadable"); } }).ports, { proposalDigest: testEnvDigest(environment), environment, signal: new AbortController().signal, deadlineMs: 3600000, measureMachine: true });
    expect(report.fullSuite).toEqual({ durationMs: 90000, tests: 1240 });
  });
});

it("the single future setup entry point negotiates and reads the sandbox before release; old reports still parse", async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "te-c5-integration-"));
  try {
    expect(dirname(directory)).toBe(await realpath(tmpdir()));
    await writeFile(join(directory, "memory.peak"), "6442450944\n");
    const environment = env(), input = { proposalDigest: testEnvDigest(environment), environment, signal: new AbortController().signal, deadlineMs: 3600000 };
    const old = await prove(fakes().ports); expect(TestEnvProveReportSchema.parse(old)).toEqual(old);
    for (const machineSize of [false, true]) for (const workerFeatures of [[], [TEST_ENV_PROVE_MEASURE_FEATURE]]) {
      const report = await proveWithMachineMeasurement(fakes().ports, input, { machineSize, workerFeatures, machineChip: "arm64", cgroupDirectory: directory });
      if (machineSize && workerFeatures.length > 0) expect(report.fullSuite?.peakMemoryMiB).toBe(6144);
      else expect(report).toEqual(old);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
