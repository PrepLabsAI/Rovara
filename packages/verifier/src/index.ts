/** Protocol-only verifier workspace foundation. Runtime packages are introduced in later tasks. */
export const VERIFIER_PROTOCOL = "trusted-e2e/v1" as const;
export { compileE2EScenarios } from "./scenarios.js";
export type { E2ECompiledSuite, E2EImmutableCompilationContext } from "./scenarios.js";
export { compileE2EApplicationScenarios, validateE2ECompiledApplicationAdmission, createE2EApplicationPortableChildBindings,
  encodeE2EApplicationExecutionAdmission, decodeE2EApplicationExecutionAdmission, validateE2EApplicationExecutionAdmission } from "./application-scenarios.js";
export type { E2EApplicationCompilationContext, E2ECompiledApplicationSuite, ValidatedE2EApplicationAdmission } from "./application-scenarios.js";
export { createE2EApplicationSelectionPacket, compareE2EApplicationPublicList } from "./application-identity.js";
export { buildE2EApplication } from "./application-build.js";
export { encodeE2EApplicationBuildSourceArchive, materializeE2EApplicationBuildSource, validateE2EApplicationBuildSourceManifest } from "./application-build-source.js";
export { runIsolatedE2E } from "./runtime.js";
export type { E2EIndependentAssertionReceipt } from "./runtime-assertions.js";
export { evaluateE2EAssertions } from "./runtime-assertions.js";
export { E2E_RUNTIME_ASSET_VERSION, createE2ERuntimeAssets, createE2ERuntimeLaunchId, parseE2EFirstPartyCapture } from "./runtime-assets.js";
export type { E2ERuntimeAssets, E2EFirstPartyCapture, E2EFirstPartyCaptureResult } from "./runtime-assets.js";
export { createE2EWorkerSession } from "./runtime-session.js";
export type { E2EWorkerSession, E2EWorkerSessionReadback } from "./runtime-session.js";
export { createE2EAppAdapterPacket } from "./runtime-adapter.js";
export type { E2EAppAdapterPacket } from "./runtime-adapter.js";
export { runE2EActualCli } from "./runtime-cli.js";
export type { E2EActualCliRun } from "./runtime-cli.js";
export { E2E_APPLICATION_RUNTIME_ASSET_VERSION, createE2EApplicationRuntimeAssets } from "./application-runtime-assets.js";
export type { E2EApplicationRuntimeAssets } from "./application-runtime-assets.js";
export { registerE2EApplicationCliHost, installE2EApplicationCliBridge, prepareE2EApplicationCliConfig,
  readE2EApplicationCliSupervisorReadback } from "./application-runtime-bootstrap.js";
export type { E2EApplicationCliHost, E2EApplicationCliLaunchContext } from "./application-runtime-bootstrap.js";
export { runE2EApplicationActualCli } from "./application-runtime-cli.js";
export { createInstalledE2EApplicationSupervisorReadbackClient } from "./application-runtime-cli.js";
export type { E2EActualApplicationCliInput, E2EApplicationSupervisorReadbackExpected, E2EApplicationSupervisorReadbackClient } from "./application-runtime-cli.js";
export { E2EApplicationReportSchema, E2E_APPLICATION_REPORT_MAX_BYTES, parseE2EApplicationReport } from "./application-report-schema.js";
export type { E2EApplicationReport, ParsedE2EApplicationReport } from "./application-report-schema.js";
export { E2EApplicationProducerSchema, E2EApplicationProofBytesSchema, E2EApplicationSupervisorReadbackSchema,
  E2EApplicationOwnedSubjectSchema, E2EApplicationCaseCaptureSchema, readE2EApplicationSupervisorProof,
  E2EApplicationCollectionSchema, E2EApplicationCollectionOracleSchema, E2EApplicationGroupResultEnvelopeSchema,
  e2eApplicationPrivateTransferMaxBytes, createE2EApplicationCollectionOracleFromCompiledSuite,
  qualifyE2EApplicationCollection, mapE2EApplicationGroupResult } from "./application-result-adapter.js";
export type { E2EApplicationProducer, E2EApplicationProofBytes, E2EApplicationSupervisorReadback, E2EApplicationOwnedSubject, E2EApplicationCaseCapture,
  E2EApplicationMockConsumption, E2EApplicationCollection, E2EApplicationCollectionOracle, E2EApplicationGroupResultEnvelope } from "./application-result-adapter.js";
export { collectE2EApplicationRun } from "./application-collection.js";
export type { E2EActualApplicationRun, E2EActualApplicationShard } from "./application-collection.js";
export { runIsolatedE2EApplication } from "./application-runtime.js";
export type { E2EApplicationRuntimePorts, E2EIsolatedApplicationRun } from "./application-runtime.js";
export { CONTAINED_IMAGE, CONTAINED_RUNTIME_PROFILE, CONTAINED_SOCKET, containedRuntimeProfileForHost, inspectContainedRuntimeReadiness, inspectContainedRuntimeReadinessForHost } from "./contained-candidate.js";
export type { ContainedRuntimeProfile } from "./container-envelope.js";
export type { ContainedRuntimeReadiness } from "./contained-runtime-readiness.js";
export { observeInstalledRuntimeManifestForHost } from "./installed-runtime-manifest.js";
export type { InstalledRuntimeManifest } from "./installed-runtime-manifest.js";
export { collectE2EActualCliRun, e2eSnapshotSourceDigest } from "./runtime-collection.js";
export type { E2EActualCollectionResult } from "./runtime-collection.js";
export { qualifyInstalledP0Runtime } from "./install-qualification.js";
export { verifyE2ECompiledFileInventory, expectedE2EConfigDigest } from "./identity.js";
export { E2EReportSchema, type E2EReport } from "./report-schema.js";
export { E2E_REPORT_MAX_BYTES, E2E_APP_RPC_FRAME_MAX_BYTES, E2E_APP_LITERAL_MAX_BYTES, E2E_APP_LITERAL_MAX_DEPTH, E2E_COLLECTION_ORACLE_MAX_CARRIER_BYTES, e2ePrivateTransferMaxBytes, E2E_MODULE_EXPORT_INVENTORY_PROTOCOL, E2E_MODULE_EXPORT_PROJECTION_VERSION, parseE2EReport, qualifyE2EReport, createE2ECollectionOracleFromCompiledSuite, qualifyE2ECollection, projectE2EModuleExportNames, type E2EReportMapping, type E2EReportExpectation, type ParsedE2EReport, type E2ECollectionOracle, type E2ECollection, type E2EObservedReceipt, type E2ECaseObservation, type E2EStructuralQualification } from "./result-adapter.js";
export { runE2EExecutor } from "./executor/run.js";
export type { E2EExecutorRunInput, E2EExecutorExitCode } from "./executor/run.js";
export { E2E_EXECUTOR_HOST_PROFILE_ID, E2E_EXECUTOR_HOST_ENTRY_POINT_ID, E2E_EXECUTOR_HOST_MODULE_PATH, verifyExecutorHostRegistration } from "./executor/host-registry.js";
export { createWebApplicationCliHost } from "./web-runtime.js";
export type { E2EWebRuntimePorts } from "./web-runtime.js";
export { createAPIApplicationCliHost } from "./api-runtime.js";
export type { E2EApiRuntimePorts, E2EApiRuntimeResponse } from "./api-runtime.js";
export { prepareE2EApplicationEnvironment, sealE2EApplicationEnvironment } from "./application-services.js";
export type { E2EApplicationPreparationInputs, E2EApplicationEnvironmentPorts } from "./application-services.js";
