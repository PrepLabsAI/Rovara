import { createHash } from "node:crypto";
import { E2ERoundSchema, E2ERunBindingSchema, ProjectSetupRunnerToolchainSchema, canonicalJson } from "@agentx/contracts";
import type { E2EApplicationEvidenceRef, E2ERound, E2ERunBinding, ProjectSetupRunnerToolchain } from "@agentx/contracts";
import { collectE2EApplicationRun as collect, encodeE2EApplicationSupervisorReadback, e2eApplicationErrorReason, e2eApplicationPrivateTransferMaxBytes,
  normalizeE2EApplicationPublicList, readE2EApplicationSupervisorProof } from "./application-result-adapter.js";
import type { E2EApplicationCaseCapture, E2EApplicationSupervisorReadback } from "./application-result-adapter.js";
import { validateE2ECompiledApplicationAdmission, type E2ECompiledApplicationSuite } from "./application-scenarios.js";
import type { E2EApplicationCollectionResult } from "./application-result-adapter.js";
import type { ExecutorOutputEvidence } from "./host/executor-readback.js";

function encoded(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 4_194_304) throw new Error("application CLI output bytes exceed the pinned per-stream bound");
  return { bytesBase64: Buffer.from(bytes).toString("base64"), byteLength: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex") }; }

export type E2EActualApplicationShard = Readonly<{
  shardId: string; launchId: string; launchConfigDigest: string; fixedAssetDigests: Readonly<Record<string, string>>; publicList: unknown;
  listStdoutBytes: Uint8Array; listStderrBytes: Uint8Array; rawReportBytes: Uint8Array; runStderrBytes: Uint8Array;
  runStartCaptureBytes: Uint8Array; runStartCapture: unknown;
  listProcess: { status: number | null; signal: string | null; startedAt: string; finishedAt: string; timedOut: boolean; aborted: boolean;
    stdoutSha256: string; stderrSha256: string; stdoutBytes: number; stderrBytes: number };
  runProcess: { status: number | null; signal: string | null; startedAt: string; finishedAt: string; timedOut: boolean; aborted: boolean;
    stdoutSha256: string; stderrSha256: string; stdoutBytes: number; stderrBytes: number };
}>;
export type E2EActualApplicationRun = Readonly<{ protocol: "e2e-actual-application-run/v1"; runnerToolchain: ProjectSetupRunnerToolchain;
  shards: readonly E2EActualApplicationShard[]; applicationCaptures: readonly E2EApplicationCaseCapture[]; supervisorReceiptRefs: readonly E2EApplicationEvidenceRef[];
  declaredMockComponentIds: readonly string[]; selected: number; filtered: number;
  supervisorReadback: E2EApplicationSupervisorReadback | null;
  cleanupConfirmed: boolean | null; cleanupServerListening: boolean | null; evidenceDirectory: string;
  /** The executor's log head and the screenshots and traces of failed cases, for the operator's evidence. The collector never reads it and no result depends on it. */
  executorEvidence?: ExecutorOutputEvidence }>;

/** Converts real supervisor readback bytes to the private strict collection wire format. */
export function collectE2EApplicationRun(input: { actual: E2EActualApplicationRun; compiled: E2ECompiledApplicationSuite;
  binding: E2ERunBinding; round: E2ERound; environment: { ci: boolean; trustNoticeShown: boolean; os: string; arch: string; runtime: string };
  usage: Readonly<Record<string, number>>; limits: Readonly<Record<string, number>>;
  expectedSupervisorReceiptRefs: readonly E2EApplicationEvidenceRef[]; ownedResourceInventoryDigest: string;
  observationBindings: Parameters<typeof collect>[0]["observationBindings"]; assertionAssets: Parameters<typeof collect>[0]["assertionAssets"];
  governedModelReceipts: Parameters<typeof collect>[0]["governedModelReceipts"]; agentModel?: Parameters<typeof collect>[0]["agentModel"]; roundScope?: Parameters<typeof collect>[0]["roundScope"]; ownedClosedAt: string | null }): E2EApplicationCollectionResult {
  try {
    const binding = E2ERunBindingSchema.parse(input.binding); const round = E2ERoundSchema.parse(input.round);
    const toolchain = ProjectSetupRunnerToolchainSchema.parse(input.actual.runnerToolchain);
    validateE2ECompiledApplicationAdmission(input.compiled, input.compiled.runtimeAdmissionContext.selectionInput.sourceSnapshot);
    const selected = input.compiled.shards.reduce((total, shard) => total + shard.selection.tuples.length, 0);
    for (const shard of input.actual.shards) {
      const compiledShard = input.compiled.shards.find((item) => item.shardId === shard.shardId);
      if (!compiledShard || shard.listStdoutBytes.byteLength > 4_194_304) throw new Error("actual CLI list output is absent or exceeds its bounded shard output");
      let rawPublicList: unknown;
      try { rawPublicList = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(shard.listStdoutBytes)); }
      catch { throw new Error("actual CLI list output is not valid UTF-8 JSON"); }
      const normalizedPublicList = normalizeE2EApplicationPublicList(rawPublicList, compiledShard.selection.targetId);
      if (canonicalJson(normalizedPublicList) !== canonicalJson(shard.publicList)) {
        throw new Error("actual CLI list bytes do not bind to the normalized public list used by the post-close collector");
      }
    }
    if (input.actual.protocol !== "e2e-actual-application-run/v1" || !input.actual.supervisorReadback
      || input.actual.shards.length !== input.compiled.shards.length || input.actual.selected !== selected || input.actual.filtered !== 0
      || toolchain.version !== process.version || toolchain.execPath !== process.execPath || toolchain.platform !== process.platform
      || toolchain.arch !== process.arch || process.version !== "v22.23.2") throw new Error("application supervisor readback is incomplete, outside its exact selection, or owned cleanup is pending");
    const proof = readE2EApplicationSupervisorProof({ readback: input.actual.supervisorReadback,
      expected: { bindingDigest: createHash("sha256").update(canonicalJson(binding)).digest("hex"),
        compiledInventoryDigest: input.compiled.inventory.digest, preparedEnvironmentDigest: input.compiled.preparedEnvironmentDigest,
        candidateDigest: binding.candidateDigest, roundId: binding.roundId, runId: binding.runId, groupId: binding.groupId,
        mockManifestDigest: binding.mockManifestDigest, caseCount: binding.expectedCases.length,
        expectedSupervisorReceiptRefs: input.expectedSupervisorReceiptRefs, ownedResourceInventoryDigest: input.ownedResourceInventoryDigest,
        launches: input.actual.shards.map((shard) => {
          const capture = shard.runStartCapture;
          const upstreamRunId = typeof capture === "object" && capture !== null && "runId" in capture && typeof capture.runId === "string"
            ? capture.runId : "";
          return { shardId: shard.shardId, launchId: shard.launchId, upstreamRunId };
        }) },
      applicationCaptures: input.actual.applicationCaptures, supervisorReceiptRefs: input.actual.supervisorReceiptRefs,
      cleanupConfirmed: input.actual.cleanupConfirmed, cleanupServerListening: input.actual.cleanupServerListening });
    const shards = input.actual.shards.map((shard) => {
      const expected = input.compiled.shards.find((item) => item.shardId === shard.shardId);
      if (!expected || shard.launchConfigDigest !== expected.expectedConfigDigest
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(shard.launchId)) throw new Error("actual shard readback differs from the exact compiled shard");
      return { shardId: shard.shardId, launchId: shard.launchId, launchConfigDigest: shard.launchConfigDigest, fixedAssetDigests: shard.fixedAssetDigests,
        publicList: shard.publicList, publicListBytes: encoded(shard.listStdoutBytes), listStderr: encoded(shard.listStderrBytes),
        rawReport: encoded(shard.rawReportBytes), runStderr: encoded(shard.runStderrBytes),
        runStartCapture: encoded(shard.runStartCaptureBytes), runStart: shard.runStartCapture, listProcess: shard.listProcess, runProcess: shard.runProcess };
    });
    const supervisorReadback = encodeE2EApplicationSupervisorReadback(proof.readback);
    const collection = { protocol: "e2e-application-collection/v1" as const, shards,
      applicationCaptures: proof.captures, supervisorReceiptRefs: input.actual.supervisorReceiptRefs,
      mockConsumptions: proof.mockConsumptions, ...(proof.unmockedCalls.length > 0 ? { unmockedCalls: proof.unmockedCalls } : {}),
      declaredMockComponentIds: [...input.actual.declaredMockComponentIds].sort(),
      supervisorReadback, receivedAt: new Date().toISOString(), cleanup: "confirmed" as const };
    if (Buffer.byteLength(canonicalJson(collection)) > Math.min(26_214_400, e2eApplicationPrivateTransferMaxBytes(Math.max(1, input.actual.applicationCaptures.length), shards.length))) {
      throw new Error("complete application collection and raw supervisor proof exceed the unchanged private transfer ceiling");
    }
    if (canonicalJson([...input.compiled.shards.map((item) => item.shardId)].sort()) !== canonicalJson(shards.map((item) => item.shardId).sort())) throw new Error("actual application run omits or duplicates a compiled shard");
    return collect({ actual: collection, compiled: input.compiled, binding, round, environment: input.environment, usage: input.usage, limits: input.limits,
      expectedSupervisorReceiptRefs: input.expectedSupervisorReceiptRefs, ownedResourceInventoryDigest: input.ownedResourceInventoryDigest,
      observationBindings: input.observationBindings, assertionAssets: input.assertionAssets, governedModelReceipts: input.governedModelReceipts,
      ...(input.agentModel == null ? {} : { agentModel: input.agentModel }), ...(input.roundScope === undefined ? {} : { roundScope: input.roundScope }), ownedClosedAt: input.ownedClosedAt });
  } catch (error) {
    return { collection: null, oracle: null, qualification: null, unavailableReason: e2eApplicationErrorReason(error, "application readback unavailable") };
  }
}
