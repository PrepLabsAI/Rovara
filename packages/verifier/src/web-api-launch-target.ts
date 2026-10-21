import { E2EApplicationLaunchTargetSchema, E2E_EXECUTOR_COMPILED_ORIGIN, type E2EApplicationLaunchTarget, type E2EPolicy, type E2ERegisteredRuntime } from "@agentx/contracts";
import { ROVARA_HTTP_ENGINE_DESCRIPTOR } from "./rovara-http-engine-descriptor.js";

/**
 * What the real `@e2e-dev/web` 0.14.0 engine reports about itself when it keeps every hook it has, sorted as a compiled launch declaration needs it. The runner computes
 * `artifacts` and `state` from the hooks an engine carries, and the executor keeps only the hooks the admission allows (`admitWebEngine`), so a declaration lists them
 * only when it declares the matching artifact or state capability (`webEngineCapabilities`).
 */
export const E2E_WEB_ENGINE_CAPABILITIES: readonly string[] = Object.freeze(["actions", "artifacts", "browser", "keyboard", "location", "observation", "pointer", "state"]);

/** The capability list of a web engine admitted with these artifact and state capabilities: the full list, less what the admission does not allow. */
export function webEngineCapabilities(admitted: { artifactCapabilities: readonly string[]; stateCapability: boolean }): string[] {
  return E2E_WEB_ENGINE_CAPABILITIES.filter((item) => (item !== "artifacts" || admitted.artifactCapabilities.length > 0) && (item !== "state" || admitted.stateCapability));
}

/** The factory every web and API target of the executor's runtime profile launches through (the executor's own CLI host). */
export const E2E_EXECUTOR_LAUNCH_FACTORY_ID = "executor-host" as const;

/**
 * The launch declaration of one web or API target on the executor's qualified runtime: the real installed engine descriptor of its kind, the capture
 * and state capabilities the registered runtime and the approved capture policy imply, and, for a web target, the fixed loopback origin compiled suites name
 * (the executor forwards it to the application; Ruling Q). An API target runs on Rovara's pinned first-party HTTP engine and names no application. The
 * compiler validates the result against the registered runtime, so a value built here that disagrees with it is refused before anything runs.
 */
export function webApiApplicationLaunchTarget(input: { target: { targetId: string; kind: "web" | "api"; applicationId: string; runtimeProfileId: string };
  runtime: E2ERegisteredRuntime; capture: E2EPolicy["capture"] }): E2EApplicationLaunchTarget {
  const { target, runtime, capture } = input;
  const web = target.kind === "web";
  // An API target runs on Rovara's HTTP engine, which has no artifact hook and so reports none, whatever the capture policy asks of web targets (the D3 default
  // approves screenshots for every project, and an API-only project must still match what its engine reports).
  const artifactCapabilities = web ? [capture.screenshots ? "screenshot" : null, capture.video ? "video" : null].filter((item) => item !== null) : [];
  // An API target's state assertions are the runtime's approved probes, so its engine has no state hook whatever the runtime supports.
  const stateCapability = web && runtime.capabilities.supportedAssertions.includes("state");
  return E2EApplicationLaunchTargetSchema.parse({ targetId: target.targetId, profileId: target.runtimeProfileId, factoryId: E2E_EXECUTOR_LAUNCH_FACTORY_ID,
    factoryManifestDigest: runtime.manifestDigest,
    engine: web ? { name: runtime.capabilities.engine.name, version: runtime.capabilities.engine.version, spiVersion: 1, platform: "web", capabilities: webEngineCapabilities({ artifactCapabilities, stateCapability }) }
      : { name: ROVARA_HTTP_ENGINE_DESCRIPTOR.name, version: ROVARA_HTTP_ENGINE_DESCRIPTOR.version, spiVersion: 1, platform: "api", capabilities: [...ROVARA_HTTP_ENGINE_DESCRIPTOR.capabilities] },
    artifactCapabilities, stateCapability,
    app: web ? { url: E2E_EXECUTOR_COMPILED_ORIGIN, identity: target.applicationId, environment: "test" } : null });
}
