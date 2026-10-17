import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { aggregateE2EVerification, canonicalJson, E2ERoundSchema } from "@agentx/contracts";
import { compileE2EScenarios } from "../../packages/verifier/src/scenarios.js";
import { collectE2EActualCliRun, e2eSnapshotSourceDigest } from "../../packages/verifier/src/runtime-collection.js";
import { E2EReportSchema } from "../../packages/verifier/src/report-schema.js";
import { createCompiledApiApplicationFixture, createPortableApplicationChildFixture } from "../support/e2e-application-fixture.js";

describe("combined application group result mapping", () => {
  it("exports an explicit mapper that refuses a child proof without a frozen outer admission", async () => {
    const module = await import("../../packages/verifier/src/application-result-adapter.js").catch(() => null);
    expect(module).not.toBeNull();
    if (!module) return;
    expect(module.E2EApplicationGroupResultEnvelopeSchema).toBeDefined();
    expect(module.mapE2EApplicationGroupResult).toBeTypeOf("function");
    expect(() => module.mapE2EApplicationGroupResult({ admission: {}, envelope: {}, rawEvidenceBytes: new Uint8Array() })).toThrow();
  });

  it("keeps application and genuine portable child result bindings distinct in the envelope", async () => {
    const module = await import("../../packages/verifier/src/application-result-adapter.js").catch(() => null);
    expect(module).not.toBeNull();
    if (!module) return;
    expect(module.E2EApplicationGroupResultEnvelopeSchema.safeParse({}).success).toBe(false);
  });

  it("rejects oversized raw child proof bytes before attempting to interpret an admission", async () => {
    const module = await import("../../packages/verifier/src/application-result-adapter.js");
    expect(() => module.mapE2EApplicationGroupResult({ admission: {}, envelope: {}, rawEvidenceBytes: new Uint8Array(26_214_401) }))
      .toThrow(/private artifact bound/);
  });

  it("revalidates a complete compiled application admission before projecting its exploratory group result", async () => {
    const module = await import("../../packages/verifier/src/application-result-adapter.js");
    const { compiled, binding, admission } = createCompiledApiApplicationFixture(); const expected = compiled.expectedCases[0]!;
    const rawEvidenceBytes = Buffer.from('{"proof":"offline-conformance"}');
    const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
    const coverage = { observedScope: "runtime", subject: "candidate", executedCandidateParts: [compiled.originByApplicationId[0]!.applicationId],
      realComponentIds: [], mockedComponentIds: [], observedMockedComponentIds: [], unexercisedBehaviors: [] };
    const result = { schemaVersion: 1, binding, producer: "structural-application-report-adapter", startedAt: "2026-10-17T12:00:00.000Z",
      finishedAt: "2026-10-17T12:00:01.000Z", receivedAt: "2026-10-17T12:00:02.000Z", status: "passed", qualification: "exploratory",
      executionMode: binding.executionMode, reason: "structural-application-observations-complete", cases: [{ caseId: expected.caseId,
        executionDescriptorDigest: expected.executionDescriptorDigest, accountContextId: expected.accountContextId,
        accountContextDigest: expected.accountContextDigest, status: "passed", reason: "observed", attemptCount: 1,
        assertionDigest: expected.assertionDigest, assertionReceipts: expected.assertionDigests.map((assertionDigest, assertionIndex) => ({
          assertionIndex, assertionDigest, status: "passed", reason: "observed" })), artifacts: [], coverage }],
      rawReportSha256: "a".repeat(64), modelReceiptIds: [], cleanup: "confirmed" };
    const ref = { artifactId: "application-group-proof", sha256: sha(rawEvidenceBytes), byteLength: rawEvidenceBytes.byteLength, mediaType: "application/json" };
    const envelopeBody = { schemaVersion: "e2e-application-group-result/v1", admissionDigest: (admission as { admissionDigest: string }).admissionDigest,
      groupId: binding.groupId, protocol: "trusted-e2e-application/v1", outerBinding: binding, executionBinding: binding,
      rawEvidenceRef: ref, rawEvidenceSha256: ref.sha256, result };
    const envelope = { ...envelopeBody, mappingDigest: sha(canonicalJson(envelopeBody)) };
    const mapped = module.mapE2EApplicationGroupResult({ admission, envelope, rawEvidenceBytes });
    expect(mapped.binding).toEqual(binding);
    expect(mapped.qualification).toBe("exploratory");
    expect(mapped.status).toBe("passed");
    expect(() => module.mapE2EApplicationGroupResult({ admission, envelope, rawEvidenceBytes: Buffer.from("changed") })).toThrow();
  });

  it("maps a source-derived portable child with fresh child IDs back to its exact outer binding", async () => {
    const module = await import("../../packages/verifier/src/application-result-adapter.js");
    const fixture = createPortableApplicationChildFixture(); const child = fixture.childBinding; const outer = fixture.outerBinding;
    const expected = child.expectedCases[0]!; const rawEvidenceBytes = Buffer.from('{"child":"source-derived portable fixture"}');
    const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
    const result = { schemaVersion: 1, binding: child, producer: "structural-e2e-report-adapter", startedAt: child.admittedAt,
      finishedAt: new Date(Date.parse(child.admittedAt) + 1_000).toISOString(), receivedAt: new Date(Date.parse(child.admittedAt) + 2_000).toISOString(), status: "passed", qualification: "exploratory",
      executionMode: child.executionMode, reason: "structural-observations-complete", cases: [{ caseId: expected.caseId,
        executionDescriptorDigest: expected.executionDescriptorDigest, accountContextId: expected.accountContextId,
        accountContextDigest: expected.accountContextDigest, status: "passed", reason: "observed", attemptCount: 1,
        assertionDigest: expected.assertionDigest, assertionReceipts: expected.assertionDigests.map((assertionDigest, assertionIndex) => ({
          assertionIndex, assertionDigest, status: "passed", reason: "observed" })), artifacts: [], coverage: { observedScope: "mock-contract",
          subject: "candidate", executedCandidateParts: ["source-derived-portable-operation"], realComponentIds: [], mockedComponentIds: [],
          observedMockedComponentIds: [], unexercisedBehaviors: [] } }], rawReportSha256: "a".repeat(64), modelReceiptIds: [], cleanup: "confirmed" };
    const ref = { artifactId: "portable-child-proof", sha256: sha(rawEvidenceBytes), byteLength: rawEvidenceBytes.byteLength, mediaType: "application/json" };
    const envelopeBody = { schemaVersion: "e2e-application-group-result/v1", admissionDigest: (fixture.admission as { admissionDigest: string }).admissionDigest,
      groupId: child.groupId, protocol: "trusted-e2e/v1", outerBinding: outer, executionBinding: child, rawEvidenceRef: ref, rawEvidenceSha256: ref.sha256, result };
    const envelope = { ...envelopeBody, mappingDigest: sha(canonicalJson(envelopeBody)) };
    const mapped = module.mapE2EApplicationGroupResult({ admission: fixture.admission, envelope, rawEvidenceBytes });
    expect(child.runId).not.toBe(outer.runId); expect(child.roundId).not.toBe(outer.roundId);
    expect(child.executionPlanDigest).not.toBe(outer.executionPlanDigest); expect(child.bundleDigest).not.toBe(outer.bundleDigest);
    const nativeCriterion = fixture.executionPlan.criteria.find((criterion) => criterion.requestedTargetId === fixture.nativeTargetId);
    expect(nativeCriterion).toBeDefined();
    expect(fixture.executionPlan.unavailableCriteria).toContainEqual(expect.objectContaining({ criterionId: nativeCriterion!.criterionId }));
    expect(fixture.projection.executionPlan.criteria.some((criterion) => criterion.requestedTargetId === fixture.nativeTargetId)).toBe(false);
    expect(mapped.binding).toEqual(outer); expect(mapped.qualification).toBe("exploratory"); expect(mapped.cases).toEqual(result.cases);
    expect(() => module.mapE2EApplicationGroupResult({ admission: fixture.admission, envelope, rawEvidenceBytes: Buffer.from("substituted") })).toThrow();
  });

  it("maps the genuine source-compiled legacy collector result through the portable child envelope", async () => {
    const module = await import("../../packages/verifier/src/application-result-adapter.js");
    const fixture = createPortableApplicationChildFixture();
    const group = fixture.projection.executionPlan.groups[0]!;
    const compiled = compileE2EScenarios(fixture.projection.bundle, fixture.projection.executionPlan.effectiveTargets, group,
      { selectionInput: fixture.projection.selectionInput, executionPlan: fixture.projection.executionPlan, group });
    const selection = JSON.parse(compiled.files.get(compiled.selectionPacketPath)!) as { tuples: Array<Record<string, unknown>> };
    const child = fixture.childBinding; const expected = child.expectedCases[0]!; const tuple = selection.tuples[0]!;
    const runId = "019a0000-0000-7000-8000-000000000001";
    const startedAt = new Date(Date.parse(child.admittedAt) + 100).toISOString();
    const finishedAt = new Date(Date.parse(startedAt) + 1_000).toISOString();
    const attemptAt = new Date(Date.parse(startedAt) + 100).toISOString();
    const wireId = "0123456789abcdef0123456789abcdef0123456789abcdef";
    const requestBytes = Buffer.from(canonicalJson({ wireId, input: fixture.projection.selectionInput.scenarios[0]!.steps[0]!.kind === "invoke-contract"
      ? fixture.projection.selectionInput.scenarios[0]!.steps[0].input : null }));
    const output = { rows: ["row-1"] };
    const responseBytes = Buffer.from(canonicalJson({ wireId, output }));
    const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
    const hostRequestId = "portable-host-request-1";
    const sourceDigest = e2eSnapshotSourceDigest(compiled, fixture.snapshot.sources.map((source) => ({ path: source.path, sha256: source.sha256 })));
    const configDigest = compiled.expectedConfigDigest;
    const fixedAssetDigests = { bootstrap: sha("portable-bootstrap"), reporter: sha("portable-reporter") };
    const limits = { maxAgentContextBytes: 1024, maxLedgerBytes: 1024, maxObservationBytes: 1024, maxEventsPerStep: 1000, maxModelTokensPerCall: 1024 };
    const usage = { discoveredResults: 1, maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0,
      downloads: 0, events: 0, modelTokens: 0, maxModelCallsInStep: 0, maxActionStepsInStep: 0 };
    const publicList = { pairs: [{ id: tuple.upstreamResultId, file: ".agentx/e2e/generated-contract.test.ts", title: tuple.title,
      titlePath: [tuple.title], kind: "test", sessions: [], target: tuple.targetName, agent: "default", disposition: "run",
      source: { file: ".agentx/e2e/generated-contract.test.ts", line: 1, column: 1 }, tags: [] }], unmatched: [] };
    const generated = compiled.files.get(".agentx/e2e/generated-contract.test.ts");
    if (!generated) throw new Error("compiled generated test source is missing");
    const reportSourceLine = generated.split("\n").findIndex((line) => line.startsWith(`test(${JSON.stringify(tuple.title)},`)) + 1;
    const actualReport = E2EReportSchema.parse({ schemaVersion: "report-1", run: { id: runId, specVersion: "0.1",
      runner: { name: "e2e", version: "0.20.0" }, status: "passed", exitCode: 0, startedAt, finishedAt,
      project: { id: "rovara-contract-p0", configDigest }, environment: { ci: false, trustNoticeShown: true, os: "darwin", arch: "arm64", runtime: "node" },
      targets: [{ id: tuple.targetName, index: 0, platform: tuple.targetName, environment: "test", engine: { name: "none", version: "unversioned", spiVersion: 1 },
        capabilities: [], artifactCapabilities: [], stateCapability: false }], serialGroups: [],
      results: [{ id: tuple.upstreamResultId, testId: tuple.upstreamTestId, kind: "test", declarationIndex: 0, titlePath: [tuple.title],
        file: ".agentx/e2e/generated-contract.test.ts", source: { file: ".agentx/e2e/generated-contract.test.ts", line: reportSourceLine, column: 1 },
        targetId: tuple.targetName, platform: tuple.targetName, agent: "default", repeat: 0, tags: [], selected: true, status: "passed",
        attempts: [{ id: runId, index: 0, status: "passed", startedAt: attemptAt, durationMs: 50, steps: [], artifacts: [], secondaryErrors: [], cleanup: "complete" }] }],
      errors: [], summary: { discovered: 1, selected: 1, executed: 1, passed: 1, failed: 0, interrupted: 0, flaky: 0, skipped: 0 }, limits, usage } });
    const reportBytes = Buffer.from(JSON.stringify(actualReport));
    const capture = { caseId: expected.caseId, declaredMockComponentIds: [], wireId,
      capture: { requestFrameBase64: requestBytes.toString("base64"), stdoutFrameBase64: responseBytes.toString("base64"), stderrFrameBase64: "",
        times: { lastOutput: { wallMs: Date.parse(attemptAt) + 10 } } }, receipt: { recordRef: "owned-lifecycle-portable", cleanup: "confirmed" } };
    const receipts = expected.assertionDigests.map((assertionDigest, assertionIndex) => ({ caseId: expected.caseId, assertionIndex, assertionDigest,
      responseSha256: sha(responseBytes), outcome: "passed" }));
    const runStart = { status: "valid", capture: { schemaVersion: "e2e-run-start-capture/v1", challenge: "11111111-1111-4111-8111-111111111111",
      runId, seq: 1, at: startedAt } };
    const actual = { launchId: "11111111-1111-4111-8111-111111111111", launchConfigDigest: configDigest, fixedAssetDigests, publicList,
      rawReportBytes: reportBytes, runStartCapture: runStart, assertionReceipts: receipts, declaredMockComponentIds: [], candidateCaptures: [capture],
      cleanupConfirmed: true, cleanupServerListening: false, runProcess: { status: 0, signal: null, timedOut: false, aborted: false,
        startedAt, finishedAt, stdoutBytes: reportBytes.byteLength, stderrBytes: 0 } };
    const round = E2ERoundSchema.parse(fixture.childRound);
    const collected = collectE2EActualCliRun({ actual: actual as never, compiled, binding: child, round,
      selection: selection as never, sourceDigest, semanticApprovalDigests: new Map([[expected.scenarioId, fixture.projection.scope.approvedSemanticApproval.digest]]),
      hostRequestIds: new Map([[expected.caseId, hostRequestId]]), declaredMockComponentIds: [],
      environment: actualReport.run.environment, usage, limits });
    expect(collected.qualification?.status, collected.qualification?.reason).toBe("PASS");
    expect(collected.qualification?.result?.qualification).toBe("exploratory");
    const { rawReportBytes: originalReportBytes, ...retainedActualProof } = actual;
    const rawEvidenceBytes = Buffer.from(canonicalJson({ schemaVersion: "e2e-retained-original-cli-proof/v1", ...retainedActualProof,
      originalReport: { sha256: sha(originalReportBytes), byteLength: originalReportBytes.byteLength,
        bytesBase64: originalReportBytes.toString("base64") } }));
    const evidenceRef = { artifactId: "legacy-collected-portable-result", sha256: sha(rawEvidenceBytes), byteLength: rawEvidenceBytes.byteLength, mediaType: "application/json" };
    const envelopeBody = { schemaVersion: "e2e-application-group-result/v1", admissionDigest: (fixture.admission as { admissionDigest: string }).admissionDigest,
      groupId: child.groupId, protocol: "trusted-e2e/v1", outerBinding: fixture.outerBinding, executionBinding: child,
      rawEvidenceRef: evidenceRef, rawEvidenceSha256: evidenceRef.sha256, result: collected.qualification!.result };
    const envelope = { ...envelopeBody, mappingDigest: sha(canonicalJson(envelopeBody)) };
    const mapped = module.mapE2EApplicationGroupResult({ admission: fixture.admission, envelope, rawEvidenceBytes });
    expect(mapped.binding).toEqual(fixture.outerBinding);
    expect(mapped.qualification).toBe("exploratory");
    expect(mapped.status).toBe("passed");
    const aggregate = aggregateE2EVerification(fixture.executionPlan, [mapped], E2ERoundSchema.parse(fixture.admission.round));
    expect(aggregate.results.find((item) => item.checkId === "project-e2e")?.status).toBe("UNKNOWN");

    const failedReport = structuredClone(actualReport) as unknown as { run: { status: string; exitCode: number; summary: { passed: number; failed: number };
      results: Array<{ status: string; attempts: Array<Record<string, unknown>> }> } };
    failedReport.run.status = "failed"; failedReport.run.exitCode = 1; failedReport.run.summary.passed = 0; failedReport.run.summary.failed = 1;
    failedReport.run.results[0]!.status = "failed";
    failedReport.run.results[0]!.attempts[0]!.status = "failed";
    failedReport.run.results[0]!.attempts[0]!.error = { category: "test", code: "ASSERTION_FAILED", message: "observed response differs", retryable: false };
    const failedBytes = Buffer.from(JSON.stringify(failedReport));
    const failedResponse = Buffer.from(canonicalJson({ wireId, output: { rows: ["different-row"] } }));
    const failedCapture = { ...capture, capture: { ...capture.capture, stdoutFrameBase64: failedResponse.toString("base64") } };
    const failedActual = { ...actual, rawReportBytes: failedBytes, candidateCaptures: [failedCapture],
      assertionReceipts: expected.assertionDigests.map((assertionDigest, assertionIndex) => ({ caseId: expected.caseId, assertionIndex, assertionDigest,
        responseSha256: sha(failedResponse), outcome: "failed" })),
      runProcess: { ...actual.runProcess, status: 1, stdoutBytes: failedBytes.byteLength } };
    const failedCollection = collectE2EActualCliRun({ actual: failedActual as never, compiled, binding: child, round,
      selection: selection as never, sourceDigest, semanticApprovalDigests: new Map([[expected.scenarioId, fixture.projection.scope.approvedSemanticApproval.digest]]),
      hostRequestIds: new Map([[expected.caseId, hostRequestId]]), declaredMockComponentIds: [],
      environment: actualReport.run.environment, usage, limits });
    expect(failedCollection.qualification?.status, failedCollection.qualification?.reason).toBe("FAILED");
    expect(failedCollection.qualification?.result?.status).toBe("failed");
    const { rawReportBytes: failedOriginalReportBytes, ...retainedFailedProof } = failedActual;
    const failedRawEvidence = Buffer.from(canonicalJson({ schemaVersion: "e2e-retained-original-cli-proof/v1", ...retainedFailedProof,
      originalReport: { sha256: sha(failedOriginalReportBytes), byteLength: failedOriginalReportBytes.byteLength,
        bytesBase64: failedOriginalReportBytes.toString("base64") } }));
    const failedEvidenceRef = { artifactId: "legacy-collected-portable-failure", sha256: sha(failedRawEvidence), byteLength: failedRawEvidence.byteLength, mediaType: "application/json" };
    const failedEnvelopeBody = { ...envelopeBody, rawEvidenceRef: failedEvidenceRef, rawEvidenceSha256: failedEvidenceRef.sha256,
      result: failedCollection.qualification!.result };
    const failedEnvelope = { ...failedEnvelopeBody, mappingDigest: sha(canonicalJson(failedEnvelopeBody)) };
    const mappedFailure = module.mapE2EApplicationGroupResult({ admission: fixture.admission, envelope: failedEnvelope, rawEvidenceBytes: failedRawEvidence });
    expect(mappedFailure.binding).toEqual(fixture.outerBinding);
    expect(mappedFailure.status).toBe("failed");
    expect(mappedFailure.qualification).toBe("exploratory");
  });
});
