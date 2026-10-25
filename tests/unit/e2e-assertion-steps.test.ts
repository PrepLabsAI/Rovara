import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runInsideAssertionSteps, assertionStepsOf } from "../../packages/verifier/src/assertion-steps.js";
import { e2eApplicationReportTargetMatches } from "../../packages/verifier/src/application-result-adapter.js";
import { validateE2EApplicationLaunchTarget } from "../../packages/verifier/src/application-scenarios.js";
import { createRovaraHttpEngine } from "../../packages/verifier/src/rovara-http-engine.js";
import { ROVARA_HTTP_ENGINE_DESCRIPTOR, ROVARA_HTTP_ENGINE_DIGEST, isPinnedRovaraHttpEngine } from "../../packages/verifier/src/rovara-http-engine-descriptor.js";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";

describe("approved assertions as report steps", () => {
  /** The runner's own bookkeeping: a step takes the next index when it starts and fails when its body throws. */
  function recorder(wrap = false) {
    const steps: { index: number; status: "passed" | "failed" }[] = [];
    return { steps, fixture: { async step(_requested: number, body: () => Promise<void>) {
      const record = { index: steps.length, status: "passed" as "passed" | "failed" };
      steps.push(record);
      try { await body(); } catch (error) { record.status = "failed"; throw wrap ? new Error("step failed", { cause: error }) : error; }
    }, async confirm() { steps.push({ index: steps.length, status: "passed" }); } } };
  }

  it.each([[false], [true]])("fails exactly the step of the first assertion that did not hold, at its own index (wrapped errors: %s)", async (wrap) => {
    const { steps, fixture } = recorder(wrap);
    const chain = await runInsideAssertionSteps(fixture, 3, async () => ({ failedIndex: 1, unavailableIndex: 2 }));
    expect(chain).toEqual({ outcome: { failedIndex: 1, unavailableIndex: 2 }, error: undefined });
    expect(steps).toEqual([{ index: 0, status: "passed" }, { index: 1, status: "failed" }, { index: 2, status: "passed" }]);
  });

  it("fails no step when every assertion held, and only the first when it failed before the rest were observed", async () => {
    for (const [failedIndex, expected] of [[-1, ["passed", "passed"]], [0, ["failed", "passed"]]] as const) {
      const { steps, fixture } = recorder();
      await runInsideAssertionSteps(fixture, 2, async () => ({ failedIndex, unavailableIndex: failedIndex === 0 ? 1 : -1 }));
      expect(steps.map((step) => step.status)).toEqual(expected);
    }
  });

  it("never blames an assertion step for a failure that is not an assertion (a request that could not be made, a page that did not load)", async () => {
    const { steps, fixture } = recorder();
    const navigationError = new Error("net::ERR_EMPTY_RESPONSE");
    const chain = await runInsideAssertionSteps(fixture, 3, async () => { throw navigationError; });
    expect(chain).toEqual({ outcome: null, error: navigationError });
    expect(steps.map((step) => step.status)).toEqual(["passed", "passed", "passed"]);
  });

  it("the seal step is a later passed step than every approved assertion, and the fixture refuses to be used without it (Task 4.6a)", async () => {
    const { steps, fixture } = recorder();
    const chain = await runInsideAssertionSteps(fixture, 2, async () => { await fixture.confirm(); return { failedIndex: -1, unavailableIndex: -1 }; });
    expect(chain.error).toBeUndefined();
    expect(steps).toEqual([{ index: 0, status: "passed" }, { index: 1, status: "passed" }, { index: 2, status: "passed" }]);
    expect(() => assertionStepsOf({ agentxAssertions: { step: (index: number, body: () => Promise<void>) => fixture.step(index, body) } })).toThrow(/assertion-step fixture/);
  });

  it("refuses fixtures that do not carry the assertion-step fixture", () => {
    expect(() => assertionStepsOf({})).toThrow(/assertion-step fixture/);
    expect(() => assertionStepsOf(null)).toThrow(/assertion-step fixture/);
    expect(assertionStepsOf({ agentxAssertions: recorder().fixture })).toBeDefined();
  });
});

describe("Rovara's pinned HTTP engine", () => {
  it("is the verifier package's own version, and the engine the runner builds from it matches the pinned descriptor exactly", () => {
    const pkg = JSON.parse(readFileSync("packages/verifier/package.json", "utf8")) as { version: string };
    expect(ROVARA_HTTP_ENGINE_DESCRIPTOR.version).toBe(pkg.version);
    const engine = createRovaraHttpEngine() as unknown as { name: string; version: string; spiVersion: number; platform: string; capabilities: ReadonlySet<string>; fixtures: object };
    expect({ name: engine.name, version: engine.version, spiVersion: engine.spiVersion, platform: engine.platform, capabilities: [...engine.capabilities] })
      .toEqual({ ...ROVARA_HTTP_ENGINE_DESCRIPTOR, capabilities: [...ROVARA_HTTP_ENGINE_DESCRIPTOR.capabilities] });
    expect(Object.keys(engine.fixtures)).toEqual(["agentxAssertions"]);
    expect(ROVARA_HTTP_ENGINE_DIGEST).toMatch(/^[a-f0-9]{64}$/);
  });

  const exact = { ...ROVARA_HTTP_ENGINE_DESCRIPTOR, capabilities: [...ROVARA_HTTP_ENGINE_DESCRIPTOR.capabilities] };
  const tampered: [string, object][] = [
    ["another name", { ...exact, name: "rovara-http-2" }], ["another version", { ...exact, version: "9.9.9" }], ["another platform", { ...exact, platform: "web" }],
    ["an extra capability", { ...exact, capabilities: [...exact.capabilities, "actions"] }], ["no capability", { ...exact, capabilities: [] }],
    ["a worker count", { ...exact, workers: 2 }],
  ];

  it("accepts only the exact descriptor, whatever order its capabilities are listed in", () => {
    expect(isPinnedRovaraHttpEngine(exact)).toBe(true);
    expect(isPinnedRovaraHttpEngine(null)).toBe(false);
    for (const [, engine] of tampered) expect(isPinnedRovaraHttpEngine(engine as never)).toBe(false);
  });

  const fixture = createOrdersExecutorPlan({ probe: "api-state-positive-v1" });
  const context = fixture.compiled.runtimeAdmissionContext;
  const target = context.executionPlan.effectiveTargets[0]!;
  const launch = context.launchTargets.find((item) => item.targetId === target.targetId)!;
  const runtime = context.runtimeBindings.get(launch.profileId)!;
  const capture = context.selectionInput.policy.capture;

  it("lets the compiler accept an API launch target on that engine only", () => {
    expect(launch.engine).toEqual(exact);
    expect(() => validateE2EApplicationLaunchTarget(target, launch, runtime, capture)).not.toThrow();
    for (const [name, engine] of tampered) {
      expect(() => validateE2EApplicationLaunchTarget(target, { ...launch, engine: engine as never }, runtime, capture), name).toThrow();
    }
    // The registered runtime profile must advertise the same engine, and an API target never carries an app.
    expect(() => validateE2EApplicationLaunchTarget(target, launch, { ...runtime, capabilities: { ...runtime.capabilities,
      engine: { ...(runtime.capabilities as { engine: object }).engine, version: "9.9.9" } } } as never, capture)).toThrow();
    expect(() => validateE2EApplicationLaunchTarget(target, { ...launch, app: { identity: "x", environment: "test" } }, runtime, capture)).toThrow();
    // The engine has no state hook, so it never claims state capability, whatever assertions the runtime supports.
    expect(() => validateE2EApplicationLaunchTarget(target, { ...launch, stateCapability: true }, runtime, capture)).toThrow();
  });

  const report = (overrides: object = {}) => ({ id: "t", index: 0, platform: "api", engine: { name: exact.name, version: exact.version, spiVersion: 1 },
    capabilities: [...exact.capabilities], artifactCapabilities: [], stateCapability: false, ...overrides }) as never;
  const expected = (engine: object | null) => ({ platform: "api", artifactCapabilities: [], stateCapability: false, engine }) as never;

  it("matches an API report only to the engine the oracle compiled, and never lets a report name another engine", () => {
    expect(e2eApplicationReportTargetMatches(report(), expected(exact))).toBe(true);
    expect(e2eApplicationReportTargetMatches(report({ engine: { name: "web", version: "0.14.0", spiVersion: 1 } }), expected(exact))).toBe(false);
    expect(e2eApplicationReportTargetMatches(report({ engine: { name: exact.name, version: "9.9.9", spiVersion: 1 } }), expected(exact))).toBe(false);
    expect(e2eApplicationReportTargetMatches(report({ capabilities: ["agentxAssertions", "actions"] }), expected(exact))).toBe(false);
    expect(e2eApplicationReportTargetMatches(report({ stateCapability: true }), expected(exact))).toBe(false);
    // An oracle that held any other engine for an API target is refused outright, even against a report that agrees with it.
    for (const [, engine] of tampered) {
      const e = engine as { name: string; version: string; capabilities: string[]; platform: string };
      expect(e2eApplicationReportTargetMatches(report({ engine: { name: e.name, version: e.version, spiVersion: 1 }, capabilities: e.capabilities }), expected(engine))).toBe(false);
    }
    // An engine-less oracle still matches only the runner's "none" engine, never Rovara's.
    expect(e2eApplicationReportTargetMatches(report(), expected(null))).toBe(false);
    expect(e2eApplicationReportTargetMatches(report({ engine: { name: "none", version: "unversioned", spiVersion: 1 }, capabilities: [] }), expected(null))).toBe(true);
  });
});
