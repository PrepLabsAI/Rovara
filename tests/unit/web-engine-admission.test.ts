import { describe, expect, it } from "vitest";
import { web } from "@e2e-dev/web";
import { E2EPolicySchema } from "@agentx/contracts";
import { PROFILE, webApiRow } from "../support/e2e-application-plan-fixtures.js";
import { admitWebEngine } from "../../packages/verifier/src/web-runtime.js";
import { E2E_WEB_ENGINE_CAPABILITIES, webApiApplicationLaunchTarget } from "../../packages/verifier/src/web-api-launch-target.js";
import { validateE2EApplicationLaunchTarget } from "../../packages/verifier/src/application-scenarios.js";

// What the engine tells the runner about itself is what the report's target says (`describeTarget` in e2e 0.20.0): the artifact kinds it can record (a
// screenshot when it has `artifacts`, a video when that has `startVideo`), whether it has a `state` hook, and its capability list. The oracle compares that with what
// the admission declared, which is derived from the admitted capture policy and runtime row. So an engine must be exactly as capable as the admission says.
const reported = (engine: { artifacts?: { startVideo?: unknown }; state?: unknown; capabilities: ReadonlySet<string> | readonly string[] }) => ({
  artifactCapabilities: engine.artifacts === undefined ? [] : ["screenshot", ...(engine.artifacts.startVideo === undefined ? [] : ["video"])],
  stateCapability: engine.state !== undefined, capabilities: [...engine.capabilities].sort() });
const base = () => web({ browser: "chromium", connect: { cdpEndpoint: async () => "wss://unused.invalid" } });
const OFF = { screenshots: false, traces: false, video: false, downloads: false };

describe("the web engine an executor presents is the one the admission declared", () => {

  it("takes screenshots only when only screenshots are admitted", () => {
    const engine = admitWebEngine(base(), { artifactCapabilities: ["screenshot"], stateCapability: false });
    expect(reported(engine)).toMatchObject({ artifactCapabilities: ["screenshot"], stateCapability: false });
    expect(engine.artifacts).not.toHaveProperty("startVideo");
    expect(engine.artifacts).toHaveProperty("screenshot");
  });

});

describe("the launch declaration and the engine agree for production-shaped and qualification-shaped policy and rows", () => {
  const target = { targetId: "t", kind: "web" as const, applicationId: "app", runtimeProfileId: PROFILE };
  const plan = { targetId: "t", kind: "web", applicationId: "app", runtimeProfileId: PROFILE, browser: "chromium" } as never;
  const launch = (row: ReturnType<typeof webApiRow>, capture: typeof OFF) => webApiApplicationLaunchTarget({ target, runtime: row, capture });

  it("declares no artifacts and no state for the policy the setup route writes and the row the registrar writes", () => {
    const declared = launch(webApiRow("web"), OFF);
    expect(declared).toMatchObject({ artifactCapabilities: [], stateCapability: false });
    expect(declared.engine!.capabilities).toEqual(E2E_WEB_ENGINE_CAPABILITIES.filter((item) => item !== "artifacts" && item !== "state"));
    expect(() => validateE2EApplicationLaunchTarget(plan, declared, webApiRow("web"), E2EPolicySchema.shape.capture.parse(OFF))).not.toThrow();
    const engine = admitWebEngine(base(), { artifactCapabilities: declared.artifactCapabilities, stateCapability: declared.stateCapability });
    expect(reported(engine)).toEqual({ artifactCapabilities: declared.artifactCapabilities, stateCapability: declared.stateCapability, capabilities: declared.engine!.capabilities });
  });

  it("refuses a declaration whose capability list claims artifacts or state the admission does not", () => {
    const declared = launch(webApiRow("web"), OFF);
    const lying = { ...declared, engine: { ...declared.engine!, capabilities: [...E2E_WEB_ENGINE_CAPABILITIES] } };
    expect(() => validateE2EApplicationLaunchTarget(plan, lying, webApiRow("web"), E2EPolicySchema.shape.capture.parse(OFF))).toThrow(/capabilit/);
  });

});
