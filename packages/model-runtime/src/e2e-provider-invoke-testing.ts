import type { E2EModelRouteDefinition } from "@agentx/contracts";
import { buildE2EProviderInvoke, type E2EProviderInvoke, type E2EProviderInvokeDependencies, type E2EProviderInvokeTesting } from "./e2e-provider-invoke.js";

/**
 * The test-only factory for the e2e provider invoke: it can point Bedrock at a loopback endpoint and give pi-ai
 * provider-scoped environment values (such as skipping auth for a fake endpoint). It is not exported from the package
 * index or its exports map, and nothing but a test imports it (a test asserts that). Production uses
 * `createE2EProviderInvoke`, which has no such overrides.
 */
export function createE2EProviderInvokeForTesting(definition: E2EModelRouteDefinition, dependencies: E2EProviderInvokeDependencies, testing: E2EProviderInvokeTesting): Promise<E2EProviderInvoke> {
  return buildE2EProviderInvoke(definition, dependencies, testing);
}
