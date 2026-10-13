/** Protocol-only verifier workspace foundation. Runtime packages are introduced in later tasks. */
export const VERIFIER_PROTOCOL = "trusted-e2e/v1" as const;
export { compileE2EScenarios } from "./scenarios.js";
export type { E2ECompiledSuite, E2EImmutableCompilationContext } from "./scenarios.js";
export { verifyE2ECompiledFileInventory, expectedE2EConfigDigest } from "./identity.js";
