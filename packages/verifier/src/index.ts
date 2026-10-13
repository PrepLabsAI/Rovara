/** Protocol-only verifier workspace foundation. Runtime packages are introduced in later tasks. */
export const VERIFIER_PROTOCOL = "trusted-e2e/v1" as const;
export { compileE2EScenarios } from "./scenarios.js";
export type { E2ECompiledSuite, E2EImmutableCompilationContext } from "./scenarios.js";
export { verifyE2ECompiledFileInventory, expectedE2EConfigDigest } from "./identity.js";
export { E2EReportSchema, type E2EReport } from "./report-schema.js";
export { E2E_REPORT_MAX_BYTES, parseE2EReport, qualifyE2EReport, type E2EReportMapping, type E2EReportExpectation, type ParsedE2EReport } from "./result-adapter.js";
