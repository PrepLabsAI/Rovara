import { createHash } from "node:crypto";
import { canonicalJson, type E2EExecutorPlan } from "@agentx/contracts";
import type { E2EActualApplicationRun } from "../../packages/verifier/src/application-collection.js";
import { readE2EApplicationSupervisorProof } from "../../packages/verifier/src/application-result-adapter.js";
import { resolveE2EExecutorSuite } from "../../packages/verifier/src/executor/suite.js";
import { collectE2EApplicationRun } from "../../packages/verifier/src/application-collection.js";
import { dockerOwnedResourceInventoryDigest, type DockerCollectionInputs } from "../../packages/verifier/src/host/executor-readback.js";

/**
 * Runs the collector's own structural check over a host-assembled readback: every byte closes, every frame binds to this
 * run's binding, and the cleanup proof matches the inventory a collector recomputes from the run id alone.
 */
export function proveActualRun(actual: E2EActualApplicationRun, plan: E2EExecutorPlan) {
  const resolved = resolveE2EExecutorSuite(plan);
  const readback = actual.supervisorReadback!;
  return readE2EApplicationSupervisorProof({ readback, expected: { bindingDigest: createHash("sha256").update(canonicalJson(resolved.binding)).digest("hex"),
    compiledInventoryDigest: resolved.suite.inventory.digest, preparedEnvironmentDigest: resolved.suite.preparedEnvironmentDigest,
    candidateDigest: resolved.binding.candidateDigest, roundId: resolved.binding.roundId, runId: resolved.binding.runId, groupId: resolved.binding.groupId,
    mockManifestDigest: resolved.binding.mockManifestDigest, caseCount: resolved.binding.expectedCases.length,
    expectedSupervisorReceiptRefs: actual.supervisorReceiptRefs.filter((ref) => ref.artifactId !== readback.receipt.ref.artifactId),
    ownedResourceInventoryDigest: dockerOwnedResourceInventoryDigest(resolved.binding.runId, []),
    launches: actual.shards.map((shard) => ({ shardId: shard.shardId, launchId: shard.launchId, upstreamRunId: (shard.runStartCapture as { runId: string }).runId })) },
  applicationCaptures: actual.applicationCaptures, supervisorReceiptRefs: actual.supervisorReceiptRefs, cleanupConfirmed: actual.cleanupConfirmed, cleanupServerListening: actual.cleanupServerListening });
}

/** The post-close join the worker performs: the host's actual run and protected inputs through the real collector. */
export function collectHostRun(actual: E2EActualApplicationRun, inputs: DockerCollectionInputs, plan: E2EExecutorPlan) {
  const resolved = resolveE2EExecutorSuite(plan);
  return collectE2EApplicationRun({ actual, compiled: resolved.suite, binding: resolved.binding, round: resolved.round, ...inputs });
}
