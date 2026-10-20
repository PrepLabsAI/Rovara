import { describe, expect, it } from "vitest";
import { web } from "@e2e-dev/web";
import { E2EPolicySchema } from "@agentx/contracts";
import { PROFILE, webApiRow } from "../support/e2e-application-plan-fixtures.js";
import { admitWebEngine } from "../../packages/verifier/src/web-runtime.js";
import { E2E_WEB_ENGINE_CAPABILITIES, webApiApplicationLaunchTarget } from "../../packages/verifier/src/web-api-launch-target.js";
import { validateE2EApplicationLaunchTarget } from "../../packages/verifier/src/application-scenarios.js";
import { ROVARA_HTTP_ENGINE_DESCRIPTOR } from "../../packages/verifier/src/rovara-http-engine-descriptor.js";
import { createRovaraHttpEngine } from "../../packages/verifier/src/rovara-http-engine.js";

// What the engine tells the runner about itself is what the report's target says (`describeTarget` in e2e 0.20.0): the artifact kinds it can record (a
// screenshot when it has `artifacts`, a video when that has `startVideo`), whether it has a `state` hook, and its capability list. The oracle compares that with what
// the admission declared, which is derived from the admitted capture policy and runtime row. So an engine must be exactly as capable as the admission says.
const reported = (engine: { artifacts?: { startVideo?: unknown }; state?: unknown; capabilities: ReadonlySet<string> | readonly string[] }) => ({
  artifactCapabilities: engine.artifacts === undefined ? [] : ["screenshot", ...(engine.artifacts.startVideo === undefined ? [] : ["video"])],
  stateCapability: engine.state !== undefined, capabilities: [...engine.capabilities].sort() });
const base = () => web({ browser: "chromium", connect: { cdpEndpoint: async () => "wss://unused.invalid" } });
const OFF = { screenshots: false, traces: false, video: false, downloads: false };
const ON = { screenshots: true, traces: false, video: true, downloads: false };

describe("the web engine an executor presents is the one the admission declared", () => {
  it("records nothing and has no state hook when capture is off and the row has no state assertion", () => {
    const engine = admitWebEngine(base(), { artifactCapabilities: [], stateCapability: false });
    expect(reported(engine)).toEqual({ artifactCapabilities: [], stateCapability: false,
      capabilities: E2E_WEB_ENGINE_CAPABILITIES.filter((item) => item !== "artifacts" && item !== "state") });
    expect(engine.artifacts).toBeUndefined();
    expect(engine.state).toBeUndefined();
  });

  it("takes screenshots only when only screenshots are admitted", () => {
    const engine = admitWebEngine(base(), { artifactCapabilities: ["screenshot"], stateCapability: false });
    expect(reported(engine)).toMatchObject({ artifactCapabilities: ["screenshot"], stateCapability: false });
    expect(engine.artifacts).not.toHaveProperty("startVideo");
    expect(engine.artifacts).toHaveProperty("screenshot");
  });

  it("is the whole pinned engine when screenshots, video and state are all admitted", () => {
    const whole = base();
    const engine = admitWebEngine(whole, { artifactCapabilities: ["screenshot", "video"], stateCapability: true });
    expect(reported(engine)).toEqual({ artifactCapabilities: ["screenshot", "video"], stateCapability: true, capabilities: [...E2E_WEB_ENGINE_CAPABILITIES] });
    expect(engine.artifacts).toBe(whole.artifacts);
    expect(engine.state).toBe(whole.state);
  });
});

describe("the launch declaration and the engine agree for production-shaped and qualification-shaped policy and rows", () => {
  const target = { targetId: "t", kind: "web" as const, applicationId: "app", runtimeProfileId: PROFILE };
  const plan = { targetId: "t", kind: "web", applicationId: "app", runtimeProfileId: PROFILE, browser: "chromium" } as never;
  const withState = () => webApiRow("web", {}, (value) => ({ ...value, supportedAssertions: [...value.supportedAssertions, "state"] }));
  const launch = (row: ReturnType<typeof webApiRow>, capture: typeof OFF) => webApiApplicationLaunchTarget({ target, runtime: row, capture });

  it("declares no artifacts and no state for the policy the setup route writes and the row the registrar writes", () => {
    const declared = launch(webApiRow("web"), OFF);
    expect(declared).toMatchObject({ artifactCapabilities: [], stateCapability: false });
    expect(declared.engine!.capabilities).toEqual(E2E_WEB_ENGINE_CAPABILITIES.filter((item) => item !== "artifacts" && item !== "state"));
    expect(() => validateE2EApplicationLaunchTarget(plan, declared, webApiRow("web"), E2EPolicySchema.shape.capture.parse(OFF))).not.toThrow();
    const engine = admitWebEngine(base(), { artifactCapabilities: declared.artifactCapabilities, stateCapability: declared.stateCapability });
    expect(reported(engine)).toEqual({ artifactCapabilities: declared.artifactCapabilities, stateCapability: declared.stateCapability, capabilities: declared.engine!.capabilities });
  });

  it("is unchanged for the qualification probes' policy and row: the whole engine, the same capability list as before", () => {
    const row = withState();
    const declared = launch(row, ON);
    expect(declared).toMatchObject({ artifactCapabilities: ["screenshot", "video"], stateCapability: true });
    expect(declared.engine!.capabilities).toEqual([...E2E_WEB_ENGINE_CAPABILITIES]);
    expect(() => validateE2EApplicationLaunchTarget(plan, declared, row, E2EPolicySchema.shape.capture.parse(ON))).not.toThrow();
  });

  it("refuses a declaration whose capability list claims artifacts or state the admission does not", () => {
    const declared = launch(webApiRow("web"), OFF);
    const lying = { ...declared, engine: { ...declared.engine!, capabilities: [...E2E_WEB_ENGINE_CAPABILITIES] } };
    expect(() => validateE2EApplicationLaunchTarget(plan, lying, webApiRow("web"), E2EPolicySchema.shape.capture.parse(OFF))).toThrow(/capabilit/);
  });

  it("keeps an API target on Rovara's pinned HTTP engine, which has no state hook and records nothing, whatever the row supports", () => {
    const apiRow = webApiRow("api");
    expect(apiRow.capabilities.supportedAssertions).toContain("state");
    const declared = webApiApplicationLaunchTarget({ target: { ...target, kind: "api" }, runtime: apiRow, capture: OFF });
    expect(declared).toMatchObject({ artifactCapabilities: [], stateCapability: false });
    expect(declared.engine!.capabilities).toEqual([...ROVARA_HTTP_ENGINE_DESCRIPTOR.capabilities]);
    expect(reported(createRovaraHttpEngine())).toMatchObject({ artifactCapabilities: [], stateCapability: false });
  });
});
