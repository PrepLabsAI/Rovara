import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, createCandidateManifest, e2eApplicationMetadataSourceRefs, e2eAppBuildManifestDigest,
  E2EApplicationPlanIntentSchema, inspectE2ERepository, proposeE2ESetup, type E2ESourceSnapshot } from "@agentx/contracts";
import { deriveE2EApplicationApprovalBinding } from "../../packages/broker/src/e2e/application-plan-binding.js";
import { buildE2EApplication } from "../../packages/verifier/src/application-build.js";
import { encodeE2EApplicationBuildSourceArchive } from "../../packages/verifier/src/application-build-source.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const gitBlob = (bytes: Uint8Array) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes])).digest("hex");
function validInput(deadlineMs = 10_000) {
  const bytes = Buffer.from(JSON.stringify({ name: "build-fixture", scripts: { start: "node server.js" } }));
  const blob = gitBlob(bytes);
  const treeSha = createHash("sha1").update(Buffer.concat([Buffer.from(`tree ${Buffer.concat([Buffer.from(`100644 package.json\0`), Buffer.from(blob, "hex")]).byteLength}\0`), Buffer.concat([Buffer.from(`100644 package.json\0`), Buffer.from(blob, "hex")])])).digest("hex");
  const candidate = createCandidateManifest([{ repositoryId: "build-repo", commitSha: "a".repeat(40), treeSha }]);
  const snapshot: E2ESourceSnapshot = { candidate, commitSha: candidate.repositories[0]!.commitSha, treeSha, treeComplete: true,
    treePaths: ["package.json"], sources: [{ path: "package.json", sha256: sha(bytes), bytes, kind: "blob" }] };
  const inspection = inspectE2ERepository(snapshot, candidate).inspection;
  const app = inspection.applications[0]!;
  const target = inspection.proposedTargets.find((item) => item.applicationId === app.applicationId)!;
  const sourceRefs = e2eApplicationMetadataSourceRefs(snapshot, app.applicationId, app.sourcePaths);
  const accountRef = { applicationId: app.applicationId, profileId: target.accountProfileId, revision: 1, definitionDigest: "b".repeat(64) };
  const scenario = { scenarioId: "launch", requirementId: "launches", requestedTargetIds: [target.targetId], required: true,
    accountProfileId: target.accountProfileId, minimumEvidence: "runtime" as const, requiredRealComponentIds: [],
    steps: [{ kind: "navigate" as const, path: "/" }], assertions: [{ kind: "visible" as const, testId: "home", equals: true }] };
  const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: [target.targetId], portableOperationRefs: [],
    mockFixtureRefs: [], accountContextRefs: [{ applicationId: app.applicationId, profileId: target.accountProfileId,
      sourcePath: "package.json", sourceSha256: sha(bytes) }], scenarios: [scenario], semanticExportDeltas: [],
    applicationRuntimeRefs: [{ targetId: target.targetId, applicationId: app.applicationId, recipeDigest: app.recipe!.recipeDigest,
      sourceRefs, runtimeProfileId: "web-runtime", accountProfileId: target.accountProfileId }], unavailableTargetRefs: [], runtimeAccountRefs: [accountRef] });
  const setupProposal = proposeE2ESetup({ inspection, snapshot, expectedCandidate: candidate });
  const setupApproval = { artifactId: "setup-approval", digest: sha(canonicalJson(setupProposal)) };
  const planDigest = "c".repeat(64);
  const approval = deriveE2EApplicationApprovalBinding({ preparedSnapshot: snapshot, intent, artifactId: "plan-approval",
    artifactSha256: "d".repeat(64), planDigest, setupProposal, setupApproval });
  const archive = encodeE2EApplicationBuildSourceArchive([{ path: "package.json", mode: "100644", bytes }]);
  const treeEntry = { path: "package.json", mode: "100644" as const, objectId: blob };
  const buildSourceBody = { schemaVersion: "e2e-application-build-source-manifest/v1" as const, candidateDigest: candidate.digest,
    repository: { repositoryId: "build-repo", commitSha: candidate.repositories[0]!.commitSha, treeSha }, sourceState: "committed-tree" as const,
    pathPolicy: "existing-safe-e2e-source-path/v1" as const, treeEntries: [treeEntry],
    files: [{ path: "package.json", mode: "100644" as const, gitBlobId: blob, sha256: sha(bytes), byteLength: bytes.byteLength }], omissions: [],
    archive: { format: "e2e-application-build-source-archive/v1" as const, sha256: archive.sha256, byteLength: archive.byteLength, fileCount: 1 } };
  const buildSourceManifest = { ...buildSourceBody, manifestDigest: sha(canonicalJson(buildSourceBody)) };
  const buildSourceReference = { artifactId: "source-archive", sha256: archive.sha256, byteLength: archive.byteLength, manifestDigest: buildSourceManifest.manifestDigest };
  const runtimeProfile = { profileId: "web-runtime", kind: "web" as const, runtimeManifestDigest: "e".repeat(64),
    applications: [{ applicationId: app.applicationId, appBuildManifestDigest: "f".repeat(64), appRecipe: app.recipe! }],
    networkPolicyDigest: "1".repeat(64), seedDigest: "2".repeat(64), limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000,
      preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1,
      maxOutputTokens: 1, maxSpendUsd: null }, capture: { screenshots: false, traces: false, video: false, downloads: false } };
  const buildOutput = { artifactId: "output-web", sha256: "3".repeat(64), appId: app.applicationId, platform: "web" as const };
  const manifestBody = { schemaVersion: "e2e-app-build/v1" as const, candidateDigest: candidate.digest, applicationId: app.applicationId,
    repository: { repositoryId: "build-repo", commitSha: candidate.repositories[0]!.commitSha, treeSha }, recipeDigest: app.recipe!.recipeDigest,
    lockfileRefs: [], toolchainManifestDigest: "4".repeat(64), outputs: [buildOutput], createdAt: "2026-10-17T16:00:00.000Z" };
  const buildManifest = { ...manifestBody, manifestDigest: e2eAppBuildManifestDigest(manifestBody) };
  const binding = { schemaVersion: "e2e-application-build-binding/v1" as const, preparationId: "11111111-1111-4111-8111-111111111111",
    taskId: "22222222-2222-4222-8222-222222222222", workspaceId: "33333333-3333-4333-8333-333333333333",
    operationId: "44444444-4444-4444-8444-444444444444", operationFence: 1, workflowRevision: 1,
    candidateDigest: candidate.digest, planDigest, intentDigest: sha(canonicalJson(intent)), applicationApprovalDigest: approval.bindingDigest,
    applicationId: app.applicationId, recipeDigest: app.recipe!.recipeDigest, buildSourceManifestDigest: buildSourceManifest.manifestDigest,
    buildSourceSha256: archive.sha256, runtimeProfileId: "web-runtime", runtimeManifestDigest: runtimeProfile.runtimeManifestDigest,
    deadlineAt: new Date(Date.now() + deadlineMs).toISOString() };
  return { input: { snapshot, buildSource: { manifest: buildSourceManifest, reference: buildSourceReference }, approval,
    approvedRecipe: app.recipe!, runtimeProfile, binding, signal: new AbortController().signal }, archive, buildManifest, buildOutput };
}
const sourceReceipt = { artifactId: "source-ingress", sha256: "5".repeat(64), byteLength: 10, mediaType: "application/json" };

// The deadline tests run on a fake clock (timers and Date) that the test advances once the port under test has been called: a ticket deadline 20-30 ms away on the
// real clock could pass before the build even started on a loaded machine, and then the port would never be called and the wrong error would be raised.
const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
/** A promise that settles when the port under test is first called, so the test advances the clock only after the deadline timer exists. */
const calledPromise = () => { let mark!: () => void; const promise = new Promise<void>((resolve) => { mark = resolve; }); return { promise, mark }; };

describe("application build lifecycle", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("does not dispatch a queued allocation after cancellation", async () => {
    const fixture = validInput();
    const controller = new AbortController();
    queueMicrotask(() => controller.abort());
    const allocateBuild = vi.fn();
    await expect(buildE2EApplication({ ...fixture.input, signal: controller.signal }, { allocateBuild } as never)).rejects.toThrow(/allocation exceeded/);
    expect(allocateBuild).not.toHaveBeenCalled();
  });

  it("validates the source-bound build ticket before asking a host to allocate", async () => {
    const allocateBuild = vi.fn();
    const executeBuild = vi.fn((_lease: unknown, _input: unknown, _signal: AbortSignal) => { void _lease; void _input; void _signal; });
    const observeOutput = vi.fn();
    const close = vi.fn();
    const ports = { allocateBuild, executeBuild, observeOutput, close } as never;
    await expect(buildE2EApplication({ snapshot: {} as never,
      buildSource: { manifest: {} as never, reference: {} as never }, approval: {} as never,
      approvedRecipe: {} as never, runtimeProfile: {} as never, binding: {} as never,
      signal: new AbortController().signal }, ports)).rejects.toThrow();
    expect(allocateBuild).not.toHaveBeenCalled();
    expect(executeBuild).not.toHaveBeenCalled();
    expect(observeOutput).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("bounds a hung allocation by the original ticket deadline", async () => {
    fakeClock();
    const fixture = validInput(30);
    const allocating = calledPromise();
    const allocateBuild = vi.fn(() => { allocating.mark(); return new Promise(() => undefined); });
    const executeBuild = vi.fn((_lease: unknown, _input: unknown, _signal: AbortSignal) => { void _lease; void _input; void _signal; });
    const observeOutput = vi.fn();
    const close = vi.fn();
    const outcome = expect(buildE2EApplication(fixture.input as never, { allocateBuild, executeBuild, observeOutput, close } as never)).rejects.toThrow(/allocation exceeded/);
    await allocating.promise;
    await vi.advanceTimersByTimeAsync(30);
    await outcome;
    expect(allocateBuild).toHaveBeenCalledOnce();
    expect(executeBuild).not.toHaveBeenCalled();
    expect(observeOutput).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("retains and closes an allocated lease when its source receipt is malformed", async () => {
    const fixture = validInput();
    const allocateBuild = vi.fn(async () => ({ leaseId: "owned-lease", sourceReceiptRef: { artifactId: "bad" } }));
    const executeBuild = vi.fn();
    const observeOutput = vi.fn();
    const close = vi.fn(async (_lease: unknown, _signal: AbortSignal) => { void _lease; void _signal; return { confirmed: true }; });
    await expect(buildE2EApplication(fixture.input as never, { allocateBuild, executeBuild, observeOutput, close } as never)).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
    expect(close.mock.calls[0]?.[0]).toMatchObject({ leaseId: "owned-lease" });
    expect(executeBuild).not.toHaveBeenCalled();
  });

  it("bounds a hung build command and closes its owned lease only once", async () => {
    fakeClock();
    const fixture = validInput(30);
    const allocateBuild = vi.fn(async () => ({ leaseId: "owned-lease", sourceReceiptRef: sourceReceipt }));
    let callSignal: AbortSignal | undefined;
    const executing = calledPromise();
    const executeBuild = vi.fn((_lease: unknown, _input: unknown, signal: AbortSignal) => { void _lease; void _input; callSignal = signal; executing.mark();
      return new Promise<{ processStatus: number | null; timedOut: boolean }>(() => undefined); });
    const observeOutput = vi.fn();
    const close = vi.fn(async (_lease: unknown, _signal: AbortSignal) => { void _lease; void _signal; return { confirmed: true }; });
    const outcome = expect(buildE2EApplication(fixture.input, { allocateBuild, executeBuild, observeOutput, close })).rejects.toThrow(/execution exceeded/);
    await executing.promise;
    await vi.advanceTimersByTimeAsync(30);
    await outcome;
    expect(executeBuild).toHaveBeenCalledOnce();
    expect(observeOutput).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(callSignal?.aborted).toBe(true);
  });

  it("bounds a hung output observation and never accepts late bytes", async () => {
    fakeClock();
    const fixture = validInput(30);
    const allocateBuild = vi.fn(async () => ({ leaseId: "owned-lease", sourceReceiptRef: sourceReceipt }));
    const executeBuild = vi.fn(async () => ({ processStatus: 0, timedOut: false }));
    const observing = calledPromise();
    const observeOutput = vi.fn((_lease: unknown, _input: unknown, _signal: AbortSignal) => { void _lease; void _input; void _signal; observing.mark(); return new Promise(() => undefined); });
    const close = vi.fn(async (_lease: unknown, _signal: AbortSignal) => { void _lease; void _signal; return { confirmed: true }; });
    const outcome = expect(buildE2EApplication(fixture.input as never, { allocateBuild, executeBuild, observeOutput, close } as never)).rejects.toThrow(/observation exceeded/);
    await observing.promise;
    await vi.advanceTimersByTimeAsync(30);
    await outcome;
    expect(observeOutput).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("cleans up a lease returned after allocation already timed out", async () => {
    fakeClock();
    const fixture = validInput(20);
    const allocating = calledPromise();
    const allocateBuild = vi.fn(async () => {
      allocating.mark();
      await new Promise((resolve) => setTimeout(resolve, 35));
      return { leaseId: "late-lease", sourceReceiptRef: sourceReceipt };
    });
    const executeBuild = vi.fn();
    const observeOutput = vi.fn();
    const close = vi.fn(async (_lease: unknown, _signal: AbortSignal) => { void _lease; void _signal; return { confirmed: true }; });
    const outcome = expect(buildE2EApplication(fixture.input, { allocateBuild, executeBuild, observeOutput, close })).rejects.toThrow(/allocation exceeded/);
    await allocating.promise;
    await vi.advanceTimersByTimeAsync(20); // the ticket deadline passes while the allocation (35 ms) is still under way
    await outcome;
    await vi.advanceTimersByTimeAsync(20); // and the lease arrives afterwards, late
    expect(close).toHaveBeenCalledOnce();
    expect(close.mock.calls[0]?.[0]).toMatchObject({ leaseId: "late-lease" });
    expect(executeBuild).not.toHaveBeenCalled();
  });

  it("runs each source-bound phase once and refuses success if cleanup is pending", async () => {
    const fixture = validInput();
    const allocateBuild = vi.fn(async () => ({ leaseId: "owned-lease", sourceReceiptRef: sourceReceipt }));
    const executeBuild = vi.fn(async (_lease: unknown, _input: unknown, _signal: AbortSignal) => { void _lease; void _input; void _signal; return { processStatus: 0, timedOut: false }; });
    const observeOutput = vi.fn(async () => ({ outputs: [fixture.buildOutput], toolchainManifestDigest: "4".repeat(64),
      supervisorReceiptRef: { artifactId: "supervisor", sha256: "6".repeat(64), byteLength: 11, mediaType: "application/json" } }));
    const close = vi.fn(async () => ({ confirmed: false }));
    await expect(buildE2EApplication(fixture.input, { allocateBuild, executeBuild, observeOutput, close })).rejects.toThrow(/cleanup is pending/);
    expect(allocateBuild).toHaveBeenCalledOnce();
    expect(executeBuild).toHaveBeenCalledOnce();
    expect(Object.keys(executeBuild.mock.calls[0]![1] as object).sort()).toEqual(["approval", "approvedRecipe", "binding", "buildSource", "runtimeProfile", "signal", "snapshot"]);
    expect(observeOutput).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps the ticket, source bytes, recipe, and runtime profile immutable across port awaits", async () => {
    const fixture = validInput();
    let resolveAllocation!: (value: { leaseId: string; sourceReceiptRef: typeof sourceReceipt }) => void;
    const allocateBuild = vi.fn(() => new Promise<{ leaseId: string; sourceReceiptRef: typeof sourceReceipt }>((resolve) => { resolveAllocation = resolve; }));
    const executeBuild = vi.fn(async (_lease: unknown, _input: unknown, _signal: AbortSignal) => { void _lease; void _input; void _signal; return { processStatus: 0, timedOut: false }; });
    const observeOutput = vi.fn(async () => ({ outputs: [fixture.buildOutput], toolchainManifestDigest: "4".repeat(64),
      supervisorReceiptRef: { artifactId: "supervisor", sha256: "6".repeat(64), byteLength: 11, mediaType: "application/json" } }));
    const close = vi.fn(async () => ({ confirmed: true }));
    const building = buildE2EApplication(fixture.input, { allocateBuild, executeBuild, observeOutput, close });
    await vi.waitFor(() => expect(allocateBuild).toHaveBeenCalledOnce());
    fixture.input.binding.deadlineAt = "2020-01-01T00:00:00.000Z";
    fixture.input.runtimeProfile.networkPolicyDigest = "9".repeat(64);
    fixture.input.snapshot.sources[0]!.bytes[0] = 0;
    resolveAllocation({ leaseId: "owned-lease", sourceReceiptRef: sourceReceipt });
    await expect(building).resolves.toMatchObject({ manifest: { schemaVersion: "e2e-app-build/v1" } });
    expect(executeBuild).toHaveBeenCalledOnce();
    const hostInput = executeBuild.mock.calls[0]?.[1] as { binding: { deadlineAt: string }; snapshot: E2ESourceSnapshot; runtimeProfile: { networkPolicyDigest: string } };
    expect(hostInput.binding.deadlineAt).not.toBe("2020-01-01T00:00:00.000Z");
    expect(Buffer.from(hostInput.snapshot.sources[0]?.bytes ?? []).equals(Buffer.from(JSON.stringify({ name: "build-fixture", scripts: { start: "node server.js" } })))).toBe(true);
    expect(hostInput.runtimeProfile.networkPolicyDigest).toBe("1".repeat(64));
    expect(close).toHaveBeenCalledOnce();
  });
});
