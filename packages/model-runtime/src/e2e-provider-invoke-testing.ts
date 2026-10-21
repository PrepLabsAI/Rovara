/**
 * The test-only factory for the e2e provider invoke. It lets a test point Bedrock at a loopback endpoint and give pi-ai
 * provider-scoped environment values. It is not exported from the package index or its exports map, and nothing but a
 * test imports this module (a test asserts that). Production uses `createE2EProviderInvoke`, which has no such overrides.
 */
export { createE2EProviderInvokeForTesting } from "./e2e-provider-invoke.js";
