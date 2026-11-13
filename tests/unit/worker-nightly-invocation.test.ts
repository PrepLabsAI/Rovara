// NH-1: the nightly run as the worker receives it: ED-1 (the broker's commit on the default branch, nothing else), the services refusal, one report to the broker, and what is sent first and last.
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, type CoverageMapData, type TestEnvironmentBody } from "@rovara-code/contracts";
import { NIGHTLY_SERVICES_UNAVAILABLE, runNightlyInvocation, type NightlyInvocationDependencies } from "../../packages/worker/src/nightly-invocation.js";
import { NIGHTLY_WALL_CLOCK_MESSAGE, type NightlyPorts } from "../../packages/worker/src/nightly-run.js";
import { counted } from "../../packages/worker/src/verification/test-report.js";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const cmd = (executable: string, args: string[] = []) => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const sha = (letter: string) => letter.repeat(64);
const body = (over: Record<string, unknown> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "svc", setupCommands: [cmd("pip", ["install"])], checks: [{ id: "unit", label: "Unit", command: cmd("pytest", ["-q"]), kind: "test", reportPath: "reports/junit.xml" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: true, cronUtc: "0 6 * * *", branch: "main" },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, ...over,
});
const payload = (over: Record<string, unknown> = {}) => ({ slotId: sha("c"), envRevision: 2, branch: "main", headSha: HEAD, environment: body(), ...over });
const invocation = (nightlyRun: unknown = payload()) => ({ kind: "task", operationId: "11111111-1111-4111-8111-111111111111", payload: { conversationId: "22222222-2222-4222-8222-222222222222", ...(nightlyRun === null ? {} : { nightlyRun }) } }) as never;
const manifest = (over: Record<string, unknown> = {}) => ({ repositories: [{ name: "svc", path: "svc", resolvedCommit: HEAD, ...over }] }) as never;

function deps(over: Partial<NightlyInvocationDependencies> = {}) {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const posted: unknown[] = [];
  const clock = { t: Date.UTC(2026, 10, 5, 6, 0, 0) };
  const ports: NightlyPorts = {
    runCommand: () => { clock.t += 1_000; return Promise.resolve({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }); },
    startMock: () => Promise.reject(new Error("none")), probePreprod: () => Promise.resolve(true), mockUnmatched: () => Promise.resolve([]),
    readReport: () => Promise.resolve(counted("junit", [{ file: "tests/a.py", name: "t1", status: "passed" }, { file: "tests/a.py", name: "t2", status: "failed" }])),
    buildCoverageMap: () => Promise.resolve(undefined as CoverageMapData | undefined),
    now: () => clock.t,
  };
  const all: NightlyInvocationDependencies = {
    rootPath: "/work", eventSink: async (batch) => { for (const event of batch) events.push({ type: event.type, payload: event.payload as Record<string, unknown> }); },
    nightlyResult: (message) => { posted.push(message); return Promise.resolve({ recorded: true }); },
    runners: { runProjectCommand: () => Promise.reject(new Error("not used")), runAgentCommand: () => Promise.reject(new Error("not used")) },
    now: () => clock.t, ports, ...over,
  };
  return { all, events, posted };
}

describe("the nightly invocation", () => {
  it("reports RUNNING first, runs the night once, posts its result once, and ends with a result that carries no tests", async () => {
    const d = deps();
    const out = await runNightlyInvocation(invocation(), d.all, manifest());
    expect(out).toEqual({ conversationId: "22222222-2222-4222-8222-222222222222", reopened: false, workflowMode: "CHECKS" });
    expect(d.events[0]).toMatchObject({ type: "lifecycle", payload: { status: "RUNNING" } });
    expect(d.events.at(-1)).toMatchObject({ type: "result", payload: { status: "SUCCEEDED", workflowMode: "CHECKS" } });
    expect(d.posted).toHaveLength(1);
    const sent = d.posted[0] as { result: { slotId: string; envRevision: number; headSha: string; tests: { total: number; failed: number } } };
    expect(sent.result).toMatchObject({ slotId: sha("c"), envRevision: 2, headSha: HEAD, tests: { total: 2, failed: 1 } });
  });

  it("ED-1: a workspace at another commit, with a pull request head, or with more than one repository is refused: no result, and the word for why is sent (branch_moved for the commit, worker_refused for the others)", async () => {
    for (const [name, m, reason] of [["commit", manifest({ resolvedCommit: OTHER }), "branch_moved"], ["pull request head", manifest({ checkedOut: { number: 4 } }), "worker_refused"], ["two repositories", { repositories: [{ name: "a", path: "a", resolvedCommit: HEAD }, { name: "b", path: "b", resolvedCommit: HEAD }] } as never, "worker_refused"]] as const) {
      const d = deps();
      await expect(runNightlyInvocation(invocation(), d.all, m), name).rejects.toThrow();
      expect(d.posted, name).toEqual([{ failed: { reason } }]);
      expect(d.events[0], name).toMatchObject({ type: "lifecycle", payload: { status: "RUNNING" } });
    }
  });

  it("refuses an environment with services (a false 'boot failed' would send the project to repair): worker_refused, no result", async () => {
    const services = [{ name: "scorer", kind: "sagemaker_runtime", match: { endpointName: "scorer" }, mode: "mock", mock: { fixtureSetRef: sha("a"), schemaRef: sha("b"), unmatched: "fail" } }];
    const d = deps();
    await expect(runNightlyInvocation(invocation(payload({ environment: body({ services }) })), d.all, manifest())).rejects.toThrow(NIGHTLY_SERVICES_UNAVAILABLE);
    expect(d.posted).toEqual([{ failed: { reason: "worker_refused" } }]);
  });

  it("a night that ran out of its wall clock says wall_clock; any other fault of the run says infra", async () => {
    const a = deps();
    a.all.wallClockMs = 20;
    a.all.ports!.runCommand = (_command, signal) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
    await expect(runNightlyInvocation(invocation(), a.all, manifest())).rejects.toThrow(NIGHTLY_WALL_CLOCK_MESSAGE);
    expect(a.posted).toEqual([{ failed: { reason: "wall_clock" } }]);
    const b = deps();
    b.all.ports!.now = () => Number.NaN;
    await expect(runNightlyInvocation(invocation(), b.all, manifest())).rejects.toThrow();
    expect(b.posted).toEqual([{ failed: { reason: "infra" } }]);
  });

  it("needs the broker's nightly action, and an invocation that names its run", async () => {
    const d = deps({ nightlyResult: undefined });
    await expect(runNightlyInvocation(invocation(), d.all, manifest())).rejects.toThrow(/nightly callback/);
    await expect(runNightlyInvocation(invocation(null), deps().all, manifest())).rejects.toThrow(/started to run/);
  });

  it("a broker that refuses the result fails the night, with an error event and no result event", async () => {
    const d = deps({ nightlyResult: () => Promise.reject(new Error("callback returned HTTP 403")) });
    await expect(runNightlyInvocation(invocation(), d.all, manifest())).rejects.toThrow(/403/);
    expect(d.events.some((event) => event.type === "error")).toBe(true);
    expect(d.events.some((event) => event.type === "result")).toBe(false);
    // The broker's refusal is not answered with another report: the one post was the result.
    expect(d.posted).toEqual([]);
  });

  it("once the result has been posted, nothing that fails afterwards is reported as a failed night: the broker already has the night (F4)", async () => {
    const d = deps();
    // The terminal event cannot be sent: the invocation fails, but exactly one thing was posted, the result.
    d.all.eventSink = async (batch) => { for (const event of batch) { if (event.type === "result") throw new Error("event sink down"); d.events.push({ type: event.type, payload: event.payload as Record<string, unknown> }); } };
    await expect(runNightlyInvocation(invocation(), d.all, manifest())).rejects.toThrow(/event sink down/);
    expect(d.posted).toHaveLength(1);
    expect(d.posted[0]).toHaveProperty("result");
    expect(d.posted[0]).not.toHaveProperty("failed");
  });

  it("a night stopped before it finished posts nothing", async () => {
    const stopAll = new AbortController();
    const d = deps();
    const base = d.all.ports!.runCommand;
    d.all.ports!.runCommand = (command, signal) => { stopAll.abort(); return base(command, signal); };
    // The cancel controller aborts the run's own signal through the registered handler.
    d.all.cancellationController = { register: (_id: string, handlers: { abort(): Promise<void> }) => { const abort = () => void handlers.abort(); stopAll.signal.addEventListener("abort", abort); return () => undefined; } } as never;
    await expect(runNightlyInvocation(invocation(), d.all, manifest())).rejects.toThrow(/stopped/);
    // A stop by a person says nothing.
    expect(d.posted).toEqual([]);
  });
});

describe("the callback body", () => {
  const bigMap = (): CoverageMapData => ({ builtAt: new Date(Date.UTC(2026, 10, 5, 6, 0, 0)).toISOString(), files: Object.fromEntries(Array.from({ length: 3 }, (_, f) => [`src/f${String(f)}.py`, Array.from({ length: 5_000 }, (__, i) => `tests/test_${String(f)}.py::${"t".repeat(470)}${String(i).padStart(5, "0")}`)])) });
  it("a map that would not fit the control plane's request limit is not sent: the result is, without the map or its reference and with the word 'too_large', and a note says so", async () => {
    const d = deps();
    d.all.ports!.buildCoverageMap = () => Promise.resolve(bigMap());
    await runNightlyInvocation(invocation(payload({ environment: body({ selection: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [] } }) })), d.all, manifest());
    expect(d.posted).toHaveLength(1);
    const sent = d.posted[0] as { result: Record<string, unknown>; coverageMap?: unknown };
    expect(sent.coverageMap).toBeUndefined();
    expect(sent.result["coverageMapRef"]).toBeUndefined();
    expect(sent.result["coverageMapSkipped"]).toBe("too_large");
    expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThan(5 * 1_048_576);
    expect(d.events.some((event) => event.type === "progress" && String(event.payload["message"]).includes("too large"))).toBe(true);
  });
  it("a map that fits is sent with its reference", async () => {
    const d = deps();
    const small = { builtAt: new Date(Date.UTC(2026, 10, 5, 6, 0, 0)).toISOString(), files: { "src/a.py": ["tests/a.py::t"] } };
    d.all.ports!.buildCoverageMap = () => Promise.resolve(small);
    await runNightlyInvocation(invocation(payload({ environment: body({ selection: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [] } }) })), d.all, manifest());
    const sent = d.posted[0] as { result: Record<string, unknown>; coverageMap?: unknown };
    expect(sent.coverageMap).toEqual(small);
    expect(sent.result["coverageMapRef"]).toMatch(/^[a-f0-9]{64}$/u);
    expect(sent.result["coverageMapSkipped"]).toBeUndefined();
  });
});
