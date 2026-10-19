import { defineEngine } from "e2e/engine";
import { ASSERTION_FIXTURE, assertionStepFixture } from "./assertion-steps.js";
import { ROVARA_HTTP_ENGINE_DESCRIPTOR } from "./rovara-http-engine-descriptor.js";

/**
 * Rovara's first-party engine for API targets: no observation, no actions, no state hooks, only the assertion-step fixture. The
 * runner computes its capabilities from what it declares, which is exactly the pinned descriptor's list.
 */
export function createRovaraHttpEngine() {
  return defineEngine({ name: ROVARA_HTTP_ENGINE_DESCRIPTOR.name, version: ROVARA_HTTP_ENGINE_DESCRIPTOR.version, spiVersion: ROVARA_HTTP_ENGINE_DESCRIPTOR.spiVersion,
    platform: ROVARA_HTTP_ENGINE_DESCRIPTOR.platform, fixtures: { [ASSERTION_FIXTURE]: assertionStepFixture } });
}
