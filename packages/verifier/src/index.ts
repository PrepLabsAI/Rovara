/** Protocol-only verifier workspace foundation. Runtime packages are introduced in later tasks. */
export const VERIFIER_PROTOCOL = "trusted-e2e/v1" as const;
export { compileE2EScenarios } from "./scenarios.js";
export type { E2ECompiledSuite, E2EImmutableCompilationContext } from "./scenarios.js";
export { verifyE2ECompiledFileInventory, expectedE2EConfigDigest } from "./identity.js";
export { E2EReportSchema, type E2EReport } from "./report-schema.js";
export { E2E_REPORT_MAX_BYTES, E2E_APP_RPC_FRAME_MAX_BYTES, E2E_APP_LITERAL_MAX_BYTES, E2E_APP_LITERAL_MAX_DEPTH, E2E_MODULE_EXPORT_INVENTORY_PROTOCOL, E2E_MODULE_EXPORT_PROJECTION_VERSION, parseE2EReport, qualifyE2EReport, createE2ECollectionOracleFromCompiledSuite, qualifyE2ECollection, projectE2EModuleExportNames, type E2EReportMapping, type E2EReportExpectation, type ParsedE2EReport, type E2ECollectionOracle, type E2ECollection, type E2EObservedReceipt, type E2ECaseObservation, type E2EStructuralQualification } from "./result-adapter.js";
