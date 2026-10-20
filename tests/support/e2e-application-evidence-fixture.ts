import { createHash } from "node:crypto";
import process from "node:process";
import { canonicalJson, type E2EApplicationExecutionAdmission, type E2ERound, type E2ERunBinding } from "@agentx/contracts";
import { collectE2EApplicationRun } from "../../packages/verifier/src/application-collection.js";
import { dockerOwnedCleanupReceipt, dockerOwnedResourceInventoryDigest } from "../../packages/verifier/src/host/executor-readback.js";
import { E2EApplicationCaseCaptureSchema, E2EApplicationObservationBindingSchema, type E2EApplicationCollectionResult } from "../../packages/verifier/src/application-result-adapter.js";
import { expectedE2EApplicationReporterDigest } from "../../packages/verifier/src/application-runtime-assets.js";
import { validateE2EApplicationExecutionAdmission, type E2ECompiledApplicationSuite, type ValidatedE2EApplicationAdmission } from "../../packages/verifier/src/application-scenarios.js";
import type { E2EApplicationReport } from "../../packages/verifier/src/application-report-schema.js";
import { ROVARA_HTTP_ENGINE_DESCRIPTOR } from "../../packages/verifier/src/rovara-http-engine-descriptor.js";
import { createOrdersExecutorPlan, type OrdersExecutorFixture, type OrdersProbeName } from "./e2e-orders-executor-fixture.js";

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const bytesOf = (value: string) => Buffer.from(value);
const frame = (artifactId: string, value: unknown) => {
  const body = Buffer.from(canonicalJson(value));
  return { ref: { artifactId, sha256: sha(body), byteLength: body.byteLength, mediaType: "application/json" }, bytes: body };
};
const rawFrame = (artifactId: string, body: Uint8Array) => ({ ref: { artifactId, sha256: sha(body), byteLength: body.byteLength, mediaType: "application/octet-stream" }, bytes: Buffer.from(body) });
const uuidA = "11111111-1111-4111-8111-111111111111";
const upstreamRunId = "a0000000-0000-7000-8000-000000000011";
const pinnedToolchain = { execPath: process.execPath, version: process.version as "v22.23.2",
  platform: process.platform as "darwin" | "linux" | "win32", arch: process.arch as "arm64" | "x64" };
/** The runner limits every application run is configured with. */
export const RUNNER_LIMITS = { maxAgentContextBytes: 16_384, maxLedgerBytes: 8_192, maxObservationBytes: 262_144, maxEventsPerStep: 1_000, maxModelTokensPerCall: 64_000 };
const STATE_PROBE_SCHEMA = { type: "object", required: ["orders", "version"], properties: { orders: { type: "string" }, version: { type: "integer" } }, additionalProperties: false };

/** What the one API case observed. */
export type ObservedApiOutcome =
  | { kind: "http-status"; status: number }
  /** The state poll ended on a 2xx answer holding another value when its budget ran out (Ruling W), or reached the approved value. */
  | { kind: "state"; finalValue: unknown; disposition: "timed-out" | "ready" };

export type ApplicationEvidenceFixture = Readonly<{
  probe: OrdersExecutorFixture; admission: E2EApplicationExecutionAdmission; validated: ValidatedE2EApplicationAdmission; compiled: E2ECompiledApplicationSuite;
  binding: E2ERunBinding; round: E2ERound; collected: E2EApplicationCollectionResult; collectionInputs: Record<string, unknown>;
  /** The group run exactly as the worker uploads it (JSON round-tripped). */
  groupRun: Record<string, unknown>; reportBytes: Buffer; runId: string; report: E2EApplicationReport;
}>;

/**
 * A genuinely collected API application group: the real probe plan's admission, a real raw runner report, supervisor receipts and cleanup proof,
 * collected by the real collector into the exact `workflow-e2e-group-evidence/v1` group run the worker uploads. The observed outcome is the only
 * thing a caller chooses; whether it is PASS, FAILED or UNKNOWN is up to the collector and the broker's recollection.
 */
export async function createApplicationEvidenceFixture(options: { probe: OrdersProbeName; observed: ObservedApiOutcome; taskId?: string;
  /** Rewrites the runner's raw report before it is serialized (for example to make the scenario skipped). */
  reportEdit?: (report: E2EApplicationReport) => void;
  /** What the runner reports as its environment and limits (self-consistently, in the report and in the readback). Default: the admitted runtime's own, and the runner's configured limits. */
  environment?: Record<string, unknown>; limits?: Record<string, number> }): Promise<ApplicationEvidenceFixture> {
  const probe = createOrdersExecutorPlan({ probe: options.probe, taskId: options.taskId ?? "44444444-4444-4444-8444-444444444444" });
  const admission: E2EApplicationExecutionAdmission = probe.plan.admission;
  const validated = validateE2EApplicationExecutionAdmission(admission);
  const compiled: E2ECompiledApplicationSuite = validated.applicationSuites[0]!;
  const binding = admission.round.groupBindings[0]!;
  const round = admission.round;
  // Every instant of the run lies between the admission and now, in millisecond steps: the collector requires receipt (now) after owned close.
  await new Promise((resolve) => setTimeout(resolve, 25));
  const admittedAt = Date.parse(round.admittedAt);
  const timeAt = (offsetMs: number) => new Date(admittedAt + offsetMs).toISOString();
  const [listStarted, listFinished, processStarted, startAt, reportStarted, reportFinished, processFinished] = [1, 2, 3, 4, 5, 6, 7].map(timeAt) as [string, string, string, string, string, string, string];

  const shard = compiled.shards[0]!; const tuple = shard.selection.tuples[0]!; const expected = compiled.expectedCases[0]!;
  const scenario = compiled.bundle.scenarios[0]!;
  const step = scenario.steps[0]!;
  const assertion = scenario.assertions[0]!;
  const app = compiled.runtimeAdmissionContext.selectionInput.intent.applicationRuntimeRefs[0]!;
  const applicationBinding = compiled.applicationBindings.get(app.applicationId)!;
  const runtime = compiled.runtimeBindings.get(app.runtimeProfileId)!;
  const origin = compiled.originByApplicationId[0]!.origin;
  const ENVIRONMENT = (options.environment ?? runtime.runnerEnvironment) as { ci: boolean; trustNoticeShown: boolean; os: string; arch: string; runtime: string };
  const LIMITS = options.limits ?? RUNNER_LIMITS;
  const accountRef = compiled.runtimeAdmissionContext.selectionInput.runtimeAccountRefs[0]!;
  const bindingDigest = sha(canonicalJson(binding));
  const producer = { producerId: "installed-api", receiptId: "supervisor-receipt", lifecycleId: "owned-api-lifecycle", operationId: binding.operationId,
    operationFence: binding.operationFence, runtimeManifestDigest: runtime.manifestDigest, transportCorrelationId: "33333333-3333-4333-8333-333333333333" };
  const context = { bindingDigest, compiledInventoryDigest: compiled.inventory.digest, preparedEnvironmentDigest: compiled.preparedEnvironmentDigest,
    candidateDigest: binding.candidateDigest, roundId: binding.roundId, runId: binding.runId, groupId: binding.groupId, lifecycleId: producer.lifecycleId,
    observedAt: processFinished, producer };
  const subject = { kind: "service" as const, processId: "owned-api-process", origin };
  const header = { schemaVersion: "e2e-application-assertion-observation/v1" as const, caseId: expected.caseId, assertionIndex: 0, assertionDigest: expected.assertionDigests[0]!,
    observationId: "observation-1", lifecycleId: producer.lifecycleId, observedAt: reportStarted, producer, subject, accountContextId: expected.accountContextId,
    accountContextDigest: expected.accountContextDigest, sessionRef: "api-session-1", accountIdDigest: sha("account") };

  const supportingEvidence: Array<ReturnType<typeof frame>> = [];
  let observationFrame: ReturnType<typeof frame>;
  let assertionValue: unknown;
  let assertionPassed: boolean;
  const assertionAssets: unknown[] = [];
  if (options.observed.kind === "http-status") {
    if (step.kind !== "request" || assertion.kind !== "http-status") throw new Error("the http-status outcome needs a request scenario with a status assertion");
    const body = rawFrame("http-response-body", bytesOf(JSON.stringify({ ok: true })));
    supportingEvidence.push(body);
    observationFrame = frame("assertion-observation", { ...header, kind: "http-status", requestId: step.requestId, responseId: "response-1", method: step.method,
      path: step.path, origin, status: options.observed.status, bodyRef: body.ref, connectionRef: null });
    assertionValue = options.observed.status;
    assertionPassed = options.observed.status === assertion.equals && step.path === assertion.path;
  } else {
    if (assertion.kind !== "state") throw new Error("the state outcome needs a scenario with a state assertion");
    const schema = frame("state-probe-schema", STATE_PROBE_SCHEMA);
    const pendingValue = frame("state-sample-pending", { orders: "loading", version: 1 });
    const finalValue = frame("state-sample-final", options.observed.finalValue);
    supportingEvidence.push(schema, pendingValue, finalValue);
    assertionAssets.push({ caseId: expected.caseId, assertionIndex: 0, kind: "state-probe", id: assertion.probeId, manifestDigest: sha("state-probe-manifest"), ref: schema.ref });
    observationFrame = frame("assertion-observation", { ...header, kind: "state", probeId: assertion.probeId, probeAssetRef: schema.ref,
      samples: [{ observedAt: timeAt(4), valueRef: pendingValue.ref, disposition: "pending", httpStatus: 200 },
        { observedAt: timeAt(5), valueRef: finalValue.ref, disposition: options.observed.disposition, httpStatus: 200 }] });
    assertionValue = options.observed.finalValue;
    assertionPassed = options.observed.disposition === "ready";
  }

  const stepKind = step.kind;
  const identitySourceReceipt = frame("identity-source-receipt", { schemaVersion: "conformance-account-source/v1", source: "offline fixture only" });
  const subjectIdentitySourceReceipt = frame("subject-identity-source-receipt", { schemaVersion: "conformance-subject-source/v1", source: "offline fixture only" });
  const identityReceipt = frame("identity-receipt", { schemaVersion: "e2e-application-account-identity/v1", caseId: expected.caseId, bindingDigest, upstreamRunId,
    lifecycleId: producer.lifecycleId, producer, observedAt: processStarted, sourceReceiptRef: identitySourceReceipt.ref, accountRef, sessionRef: "api-session-1",
    accountIdDigest: sha("account") });
  const subjectIdentityReceipt = frame("subject-identity-receipt", { schemaVersion: "e2e-application-subject-identity/v1", caseId: expected.caseId, bindingDigest, upstreamRunId,
    lifecycleId: producer.lifecycleId, producer, observedAt: processStarted, sourceReceiptRef: subjectIdentitySourceReceipt.ref, subject });
  const capture = E2EApplicationCaseCaptureSchema.parse({ schemaVersion: "e2e-application-case-capture/v1", caseId: expected.caseId, upstreamRunId, shardId: shard.shardId,
    roundId: binding.roundId, runId: binding.runId, groupId: binding.groupId, candidateDigest: binding.candidateDigest, applicationId: app.applicationId,
    buildManifestDigest: applicationBinding.build.manifestDigest, runtimeManifestDigest: runtime.manifestDigest, executionDescriptorDigest: expected.executionDescriptorDigest,
    accountContextId: expected.accountContextId, accountContextDigest: expected.accountContextDigest, observedAt: reportStarted, lifecycleId: producer.lifecycleId,
    subject, producer,
    steps: [{ index: 0, declaredStepIndex: 0, kind: stepKind, actionDigest: sha(canonicalJson(step)), observationId: "observation-1", at: reportStarted, outcome: "completed",
      evidenceRefs: [observationFrame.ref], agentOperationRefs: [] }],
    assertions: [{ index: 0, digest: expected.assertionDigests[0]!, observedAt: reportStarted, observationId: "observation-1", value: assertionValue,
      evidenceRef: observationFrame.ref, outcome: assertionPassed ? "passed" : "failed",
      reason: assertionPassed ? "observed value matches the approved assertion" : "observed value differs from the approved assertion", producer }],
    terminal: assertionPassed ? { kind: "completed" as const, lastDeclaredStepIndex: 0, failedAssertionIndex: null, at: reportFinished, reason: "complete" }
      : { kind: "assertion-failed" as const, lastDeclaredStepIndex: 0, failedAssertionIndex: 0, at: reportFinished, reason: "approved assertion observed a failure" },
    modelReceipts: [], artifacts: [identityReceipt.ref, subjectIdentityReceipt.ref].sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
    coverage: { observedScope: "runtime", subject: "candidate", executedCandidateParts: [app.applicationId], realComponentIds: [], mockedComponentIds: [], observedMockedComponentIds: [],
      unexercisedBehaviors: assertionPassed ? [] : [expected.assertionDigests[0]!] },
    cleanup: "confirmed" });
  const captureFrame = frame("case-capture", capture);
  // As the host does after close: the owned-cleanup receipt is the one supervisor receipt it attests, and the cleanup frame names it.
  const cleanupReceipt = dockerOwnedCleanupReceipt(binding.runId, processFinished);
  const cleanupFrame = frame("owned-cleanup", { schemaVersion: "e2e-application-owned-cleanup/v1", context, phase: "after-owned-close", cleanup: "confirmed", confirmed: true,
    serverListening: false, ownedResourceInventoryDigest: dockerOwnedResourceInventoryDigest(binding.runId), ownedCleanupReceiptRefs: [cleanupReceipt.ref] });
  const expectedSupervisorRefs = [cleanupReceipt.ref];
  const launches = [{ shardId: shard.shardId, launchId: uuidA, upstreamRunId }];
  const receipt = frame("supervisor-top-receipt", { schemaVersion: "e2e-application-supervisor-receipt/v1", context, launches,
    caseCaptures: [{ caseId: expected.caseId, shardId: shard.shardId, ref: captureFrame.ref }], cleanupRef: cleanupFrame.ref,
    additionalSupervisorReceiptRefs: expectedSupervisorRefs, mockConsumptions: [] });
  const readback = { schemaVersion: "e2e-application-supervisor-readback/v1" as const, receipt,
    evidence: [captureFrame, cleanupFrame, cleanupReceipt, observationFrame, identityReceipt, identitySourceReceipt, subjectIdentityReceipt, subjectIdentitySourceReceipt, ...supportingEvidence]
      .sort((left, right) => left.ref.artifactId.localeCompare(right.ref.artifactId)) };

  const publicList = { pairs: [{ id: tuple.upstreamResultId, file: ".agentx/e2e/generated-application.test.ts", title: tuple.title, titlePath: [tuple.title], kind: "test",
    sessions: [], target: tuple.targetName, agent: "default", disposition: "run", tags: [], source: tuple.source }], targets: [tuple.targetId], unmatched: [] };
  const listBytes = bytesOf(JSON.stringify({ pairs: publicList.pairs })); const stderrBytes = Buffer.alloc(0);
  const runStart = { schemaVersion: "e2e-run-start-capture/v1", challenge: uuidA, runId: upstreamRunId, seq: 1, at: startAt };
  const runStartBytes = bytesOf(`${JSON.stringify(runStart)}\n`);
  const status = assertionPassed ? "passed" as const : "failed" as const;
  const report: E2EApplicationReport = { schemaVersion: "report-1", run: { id: upstreamRunId, specVersion: "0.1", runner: { name: "e2e", version: "0.20.0" },
    status, exitCode: assertionPassed ? 0 : 1, startedAt: reportStarted, finishedAt: reportFinished, project: { id: "rovara-application-e2e", configDigest: shard.expectedConfigDigest },
    environment: ENVIRONMENT, targets: [{ id: tuple.targetId, index: 0, platform: "api", environment: "test", engine: { name: ROVARA_HTTP_ENGINE_DESCRIPTOR.name, version: ROVARA_HTTP_ENGINE_DESCRIPTOR.version, spiVersion: 1 },
      capabilities: [...ROVARA_HTTP_ENGINE_DESCRIPTOR.capabilities], artifactCapabilities: [], stateCapability: false }], serialGroups: [],
    results: [{ id: tuple.upstreamResultId, testId: tuple.upstreamTestId, kind: "test", declarationIndex: 0, titlePath: [tuple.title], file: ".agentx/e2e/generated-application.test.ts",
      source: tuple.source, targetId: tuple.targetId, platform: "api", agent: "default", repeat: 0, tags: [], selected: true, status,
      attempts: [{ id: upstreamRunId, index: 0, status, startedAt: reportStarted, durationMs: 10, artifacts: [], appLog: [], secondaryErrors: [], cleanup: "complete",
        ...(assertionPassed ? {} : { error: { category: "test", code: "ASSERTION_FAILED", message: "the approved assertion observed a failure", retryable: false, phase: "body" } }),
        steps: [{ id: "assertion-step", index: 0, kind: "assertion", api: `assert.${assertion.kind}`, label: "approved assertion", source: tuple.source,
          status, startedAt: reportStarted, durationMs: 1, events: [], artifacts: [] }] }] }],
    errors: [], summary: { discovered: 1, selected: 1, executed: 1, passed: assertionPassed ? 1 : 0, failed: assertionPassed ? 0 : 1, interrupted: 0, flaky: 0, skipped: 0 },
    limits: LIMITS,
    usage: { discoveredResults: 1, maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0, downloads: 0, events: 0, modelTokens: 0,
      maxModelCallsInStep: 0, maxActionStepsInStep: 0 } } };
  options.reportEdit?.(report);
  const reportBytes = bytesOf(JSON.stringify(report));
  const processRecord = (statusCode: number, startedAt: string, finishedAt: string, stdout: Uint8Array) => ({ status: statusCode, signal: null, startedAt, finishedAt,
    timedOut: false, aborted: false, stdoutSha256: sha(stdout), stderrSha256: sha(stderrBytes), stdoutBytes: stdout.byteLength, stderrBytes: 0 });
  const actual = { protocol: "e2e-actual-application-run/v1" as const, runnerToolchain: pinnedToolchain,
    shards: [{ shardId: shard.shardId, launchId: uuidA, launchConfigDigest: shard.expectedConfigDigest,
      fixedAssetDigests: { compilerInventory: shard.inventory.digest, reporter: expectedE2EApplicationReporterDigest(uuidA) }, publicList,
      listStdoutBytes: listBytes, listStderrBytes: stderrBytes, rawReportBytes: reportBytes, runStderrBytes: stderrBytes, runStartCaptureBytes: runStartBytes, runStartCapture: runStart,
      listProcess: processRecord(0, listStarted, listFinished, listBytes), runProcess: processRecord(assertionPassed ? 0 : 1, processStarted, processFinished, reportBytes) }],
    applicationCaptures: [capture], supervisorReceiptRefs: [receipt.ref, ...expectedSupervisorRefs].sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
    declaredMockComponentIds: [], selected: 1, filtered: 0, supervisorReadback: readback, cleanupConfirmed: true, cleanupServerListening: false, evidenceDirectory: "/offline-fixture" };
  const observationBinding = E2EApplicationObservationBindingSchema.parse({ caseId: expected.caseId, subject, caseProducer: producer,
    assertionProducers: [{ assertionIndex: 0, producer }], accountRef, sessionRef: "api-session-1", accountIdDigest: sha("account"),
    identityReceiptRef: identityReceipt.ref, subjectIdentityReceiptRef: subjectIdentityReceipt.ref, selectedArtifact: applicationBinding.artifacts[0]!, connection: null });
  // Exactly what the Docker host reads back after close (assembleDockerCollectionInputs): nothing here decides pass or fail.
  const collectionInputs = { environment: ENVIRONMENT, usage: report.run.usage as Record<string, number>, limits: report.run.limits,
    expectedSupervisorReceiptRefs: expectedSupervisorRefs, ownedResourceInventoryDigest: dockerOwnedResourceInventoryDigest(binding.runId),
    observationBindings: [observationBinding], assertionAssets, governedModelReceipts: [] as never[], ownedClosedAt: processFinished };
  const collected = collectE2EApplicationRun({ actual, compiled, binding, round, ...collectionInputs } as never);
  if (collected.collection === null || collected.qualification === null) throw new Error(`the fixture run could not be collected: ${collected.unavailableReason}`);
  const lifecycle = { cleanup: "confirmed", process: { exitCode: assertionPassed ? 0 : 1, timedOut: false, aborted: false } };
  const planGroup = validated.executionPlan.groups.find((item) => item.groupId === binding.groupId);
  const groupRun = JSON.parse(JSON.stringify({ kind: "application", group: planGroup, binding, collection: collected.qualification, unavailableReason: null, lifecycle,
    actual: { collection: collected.collection, collectionInputs }, diagnostics: null })) as Record<string, unknown>;
  return { probe, admission, validated, compiled, binding, round, collected, collectionInputs, groupRun, reportBytes, runId: binding.runId, report };
}

/** The `workflow-e2e-group-evidence/v1` envelope the worker uploads for a group, bound to the admission the broker stored. */
export function groupEvidenceEnvelope(input: { admission: E2EApplicationExecutionAdmission; admissionSha256: string; groupRun: Record<string, unknown> }) {
  const { admission } = input;
  return JSON.parse(JSON.stringify({ schemaVersion: "workflow-e2e-group-evidence/v1", admissionSha256: input.admissionSha256, taskId: admission.taskId,
    operationId: admission.operationId, operationFence: admission.operationFence, workflowRevision: admission.workflowRevision, candidateDigest: admission.candidateDigest,
    round: admission.round, groupRun: input.groupRun })) as Record<string, unknown>;
}

/** The aggregate `workflow-e2e-evidence/v1` the worker uploads last, once every group is up. */
export function aggregateEvidenceEnvelope(input: { admission: E2EApplicationExecutionAdmission; admissionSha256: string; groupRuns: Record<string, unknown>[] }) {
  const { admission } = input;
  return JSON.parse(JSON.stringify({ schemaVersion: "workflow-e2e-evidence/v1", admissionSha256: input.admissionSha256, taskId: admission.taskId,
    operationId: admission.operationId, operationFence: admission.operationFence, workflowRevision: admission.workflowRevision, candidateDigest: admission.candidateDigest,
    round: admission.round, payload: { kind: "application", groupRuns: input.groupRuns } })) as Record<string, unknown>;
}
