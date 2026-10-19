import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJson, e2eBindingDigest } from "@agentx/contracts";
import { createCompiledApiApplicationFixture } from "../support/e2e-application-fixture.js";
import { createE2EApplicationCaseCaptureFrame, createE2EApplicationAssertionObservationHeader,
  readValidatedE2EApplicationCaseObservation } from "../../packages/verifier/src/application-services.js";

const digest = "a".repeat(64);
const producer = { producerId: "web-producer", receiptId: "receipt-1", lifecycleId: "lifecycle-1",
  operationId: "11111111-1111-4111-8111-111111111111", operationFence: 1, runtimeManifestDigest: digest,
  transportCorrelationId: "22222222-2222-4222-8222-222222222222" };
const expected = { caseId: "case-1", criterionId: "criterion-1", scenarioId: "scenario-1", upstreamTestId: "test-1",
  targetId: "target-1", requestedTargetId: "target-1", agentId: "agent-1", repeat: 0 as const, executionDescriptorDigest: digest,
  accountContextId: "account-1", accountContextDigest: digest, accountProfileId: "profile-1", assertionDigest: digest,
  assertionDigests: [digest], required: true, minimumEvidence: "runtime" as const, requiredRealComponentIds: ["component-1"] };
const binding = { caseId: "case-1", subject: { kind: "service" as const, processId: "owned-api-1", origin: "https://app.test" },
  caseProducer: producer, assertionProducers: [{ assertionIndex: 0, producer }], accountRef: { applicationId: "app-1", profileId: "profile-1", revision: 1,
    definitionDigest: digest }, sessionRef: "session-1", accountIdDigest: digest,
  identityReceiptRef: { artifactId: "identity-1", sha256: digest, byteLength: 10, mediaType: "application/json" },
  subjectIdentityReceiptRef: { artifactId: "subject-1", sha256: digest, byteLength: 10, mediaType: "application/json" },
  selectedArtifact: { appId: "app-1", artifactId: "artifact-1", buildManifestDigest: digest, artifactSha256: digest }, connection: null };
const launchContext = { shardId: "shard-1", selectedTarget: { applicationId: "app-1" } };
const plan = { expected, binding: { runId: "33333333-3333-4333-8333-333333333333", roundId: "44444444-4444-4444-8444-444444444444",
  groupId: "group-1", candidateDigest: digest, runtimeManifestDigest: digest, admittedAt: "2026-10-17T12:00:00.000Z",
  deadlineAt: "2026-10-17T12:01:00.000Z" }, runtimeAccountRef: { applicationId: "app-1", profileId: "profile-1",
  revision: 1, definitionDigest: digest }, round: { roundId: "44444444-4444-4444-8444-444444444444" },
  scenario: { requiredRealComponentIds: ["component-1"] } };

describe("Task 5 application runtime frame constructors", () => {
  it("builds assertion observation headers from the assigned case and protected producer", () => {
    const header = createE2EApplicationAssertionObservationHeader({ plan: plan as never, binding: binding as never, index: 0,
      observedAt: "2026-10-17T12:00:00.000Z", observationId: "observation-1" });
    expect(header).toMatchObject({ schemaVersion: "e2e-application-assertion-observation/v1", caseId: "case-1", assertionIndex: 0,
      assertionDigest: digest, producer, subject: binding.subject, accountContextId: expected.accountContextId,
      accountContextDigest: expected.accountContextDigest, sessionRef: "session-1", accountIdDigest: digest });
  });

  it("creates strict capture frames with pending outer cleanup and honest component coverage", () => {
    const capture = createE2EApplicationCaseCaptureFrame({ plan: plan as never, launchContext: launchContext as never,
      binding: binding as never, upstreamRunId: "55555555-5555-4555-8555-555555555555", observedAt: "2026-10-17T12:00:00.000Z",
      steps: [], assertions: [{ index: 0, digest, observedAt: "2026-10-17T12:00:00.000Z", observationId: "observation-1",
        value: true, evidenceRef: null, outcome: "unavailable", reason: "not-observed", producer }], artifacts: [],
      terminal: { kind: "unavailable", lastDeclaredStepIndex: null, failedAssertionIndex: 0, at: "2026-10-17T12:00:00.000Z", reason: "not-observed" } });
    expect(capture).toMatchObject({ schemaVersion: "e2e-application-case-capture/v1", runId: plan.binding.runId,
      applicationId: "app-1", cleanup: "pending", coverage: { observedScope: "runtime", subject: "candidate",
        realComponentIds: [], mockedComponentIds: [], unexercisedBehaviors: ["component-1"] } });
  });

  it("accepts exactly the protected projection and original source receipt inventory", async () => {
    const fixture = createCompiledApiApplicationFixture({ now: "2026-10-17T12:00:00.000Z" });
    const expectedCase = fixture.compiled.expectedCases[0]!;
    const runtimeAccountRef = fixture.compiled.runtimeAdmissionContext.selectionInput.runtimeAccountRefs[0]!;
    const casePlan = { ...plan, expected: expectedCase, binding: fixture.binding, round: fixture.round, runtimeAccountRef,
      scenario: fixture.compiled.bundle.scenarios[0]! };
    const correlation = producer.transportCorrelationId;
    const currentLaunch = { ...launchContext, transportCorrelationId: correlation,
      selectedTarget: fixture.compiled.runtimeAdmissionContext.selectionInput.policy.targets.find((item) => item.targetId === expectedCase.targetId)! };
    const driver = { ...producer, lifecycleId: "lifecycle-1", operationId: fixture.binding.operationId,
      operationFence: fixture.binding.operationFence, runtimeManifestDigest: fixture.binding.runtimeManifestDigest };
    const source = (id: string) => {
      const bytes = Buffer.from(canonicalJson({ schemaVersion: "original-source/v1", id }));
      return { ref: { artifactId: id, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength,
        mediaType: "application/json" as const }, bytes };
    };
    const accountSource = source("account-source"); const subjectSource = source("subject-source");
    const upstreamRunId = "55555555-5555-4555-8555-555555555555";
    const common = { caseId: expectedCase.caseId, bindingDigest: e2eBindingDigest(fixture.binding), upstreamRunId, lifecycleId: "lifecycle-1",
      producer: driver, observedAt: "2026-10-17T12:00:30.000Z" };
    const accountProjection = { ...common, schemaVersion: "e2e-application-account-identity/v1", accountRef: casePlan.runtimeAccountRef,
      sessionRef: "session-1", accountIdDigest: digest, sourceReceiptRef: accountSource.ref };
    const serviceOrigin = fixture.compiled.originByApplicationId.find((item) => item.applicationId === runtimeAccountRef.applicationId)!.origin;
    const subject = { kind: "service" as const, processId: "service-1", origin: serviceOrigin };
    const subjectProjection = { ...common, schemaVersion: "e2e-application-subject-identity/v1", subject,
      sourceReceiptRef: subjectSource.ref };
    const proof = (id: string, value: unknown) => {
      const bytes = Buffer.from(canonicalJson(value));
      return { ref: { artifactId: id, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength,
        mediaType: "application/json" as const }, bytes };
    };
    const accountProjectionProof = proof("account-projection", accountProjection);
    const subjectProjectionProof = proof("subject-projection", subjectProjection);
    const observationBinding = { ...binding, caseId: expectedCase.caseId, subject,
      caseProducer: driver, assertionProducers: [{ assertionIndex: 0, producer: driver }], accountRef: runtimeAccountRef,
      selectedArtifact: { appId: runtimeAccountRef.applicationId, artifactId: "artifact-1", sha256: digest, platform: "api" as const, buildManifestDigest: digest },
      identityReceiptRef: accountProjectionProof.ref, subjectIdentityReceiptRef: subjectProjectionProof.ref };
    const identityEvidence = [accountProjectionProof, subjectProjectionProof, accountSource, subjectSource];
    const reader = { readCaseObservationBinding: async () => ({ observationBinding, upstreamRunId, identityEvidence }) };
    const result = await readValidatedE2EApplicationCaseObservation({ reader, launchContext: currentLaunch as never,
      plan: casePlan as never, ownedClientRef: "session-1", expectedSubjectKind: "service", signal: new AbortController().signal });
    expect(result.identityEvidence).toHaveLength(4);
    await expect(readValidatedE2EApplicationCaseObservation({ reader: { readCaseObservationBinding: async () => ({ observationBinding,
      upstreamRunId, identityEvidence: [...identityEvidence, source("extra-source")] }) }, launchContext: currentLaunch as never,
      plan: casePlan as never, ownedClientRef: "session-1", expectedSubjectKind: "service", signal: new AbortController().signal })).rejects.toThrow(/identity evidence/);
  });
});
