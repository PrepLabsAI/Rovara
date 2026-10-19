import { randomUUID } from "node:crypto";
import { E2E_EXECUTOR_COMPILED_ORIGIN, E2ETargetSchema, e2eBindingDigest, type E2EExecutorPlan, type E2ERound, type E2ERunBinding, type E2ERuntimeAccountRef,
  type E2ETarget } from "@agentx/contracts";
import type { E2EApplicationCliLaunchContext } from "../application-runtime-bootstrap.js";
import type { E2EApplicationCliCasePlan } from "../application-services.js";
import { validateE2EApplicationExecutionAdmission, type E2EApplicationCompiledShard, type E2ECompiledApplicationSuite } from "../application-scenarios.js";

export const E2E_EXECUTOR_TRANSPORT_ID = "rovara-executor-file-ledger/v1" as const;

export type ResolvedExecutorSuite = Readonly<{
  plan: E2EExecutorPlan;
  suite: E2ECompiledApplicationSuite;
  round: E2ERound;
  binding: E2ERunBinding;
  bindingDigest: string;
  /** The earliest of the plan deadline and the admitted round deadline; nothing runs after it. */
  deadlineAtMs: number;
}>;

const cache = new Map<string, ResolvedExecutorSuite>();

/**
 * Decodes the admission carried by the plan and recompiles the group with the compiler the broker used. The result is
 * the same compiled suite, so the executor never runs a test that its own compiler would not have produced.
 */
export function resolveE2EExecutorSuite(plan: E2EExecutorPlan): ResolvedExecutorSuite {
  const key = `${plan.admissionDigest}\0${plan.groupId}\0${plan.runId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const validated = validateE2EApplicationExecutionAdmission(plan.admission);
  const suite = validated.applicationSuites.find((candidate) => candidate.group.groupId === plan.groupId);
  const binding = validated.admission.round.groupBindings.find((candidate) => candidate.groupId === plan.groupId && candidate.runId === plan.runId);
  if (!suite || !binding) throw new Error("executor plan group is not a runnable application group of its admission");
  const origins = suite.originByApplicationId;
  if (origins.length === 0 || origins.some((item) => item.origin !== E2E_EXECUTOR_COMPILED_ORIGIN)) {
    throw new Error("compiled application origin differs from the loopback origin the executor serves");
  }
  const resolved: ResolvedExecutorSuite = Object.freeze({ plan, suite, round: validated.admission.round, binding,
    bindingDigest: e2eBindingDigest(binding),
    deadlineAtMs: Math.min(plan.deadlineAt, Date.parse(binding.deadlineAt)) });
  cache.set(key, resolved);
  if (cache.size > 4) cache.delete(cache.keys().next().value as string);
  return resolved;
}

export function selectedTargetFor(resolved: ResolvedExecutorSuite, targetId: string): E2ETarget {
  const target = resolved.suite.runtimeAdmissionContext.executionPlan.effectiveTargets.find((candidate) => candidate.targetId === targetId);
  if (!target) throw new Error("compiled shard target is absent from the admitted execution plan");
  return E2ETargetSchema.parse(target);
}

/** One launch per compiled shard. The ids are fresh per run and only bind the shard's files, sidecars and ledger rows together. */
export function createLaunchContexts(resolved: ResolvedExecutorSuite): readonly E2EApplicationCliLaunchContext[] {
  const transportCorrelationId = randomUUID();
  return [...resolved.suite.shards].sort((a, b) => a.shardId.localeCompare(b.shardId)).map((shard) => Object.freeze({
    schemaVersion: "e2e-application-cli-launch/v1" as const, launchId: randomUUID(), shardId: shard.shardId,
    compiledInventoryDigest: shard.inventory.digest, groupCompiledInventoryDigest: resolved.suite.inventory.digest,
    bindingDigest: resolved.bindingDigest, roundId: resolved.binding.roundId, runId: resolved.binding.runId,
    cliHost: resolved.suite.cliHost, selectedTarget: selectedTargetFor(resolved, shard.targetId),
    transportId: E2E_EXECUTOR_TRANSPORT_ID, transportCorrelationId, deadlineAt: new Date(resolved.deadlineAtMs).toISOString() }));
}

export function accountRefFor(resolved: ResolvedExecutorSuite, applicationId: string, profileId: string): E2ERuntimeAccountRef {
  const refs = resolved.suite.runtimeAdmissionContext.selectionInput.runtimeAccountRefs
    .filter((ref) => ref.applicationId === applicationId && ref.profileId === profileId);
  if (refs.length !== 1) throw new Error("the admitted selection has no single runtime account reference for this case");
  return refs[0]!;
}

export function shardOf(resolved: ResolvedExecutorSuite, shardId: string): E2EApplicationCompiledShard {
  const shard = resolved.suite.shards.find((candidate) => candidate.shardId === shardId);
  if (!shard) throw new Error("launch shard is not in the compiled suite");
  return shard;
}

/** Builds the sealed case plan the host validates again at first effect; only compiled facts go into it. */
export function casePlanFor(resolved: ResolvedExecutorSuite, input: { shardId: string; caseId: string }): E2EApplicationCliCasePlan {
  const shard = shardOf(resolved, input.shardId);
  const expected = shard.expectedCases.find((candidate) => candidate.caseId === input.caseId);
  if (!expected) throw new Error("unknown case: it is not in the compiled shard");
  const scenario = resolved.suite.bundle.scenarios.find((candidate) => candidate.scenarioId === expected.scenarioId);
  if (!scenario) throw new Error("compiled case has no approved scenario");
  const target = selectedTargetFor(resolved, expected.targetId);
  return Object.freeze({ binding: resolved.binding, round: resolved.round, groupCompiledInventoryDigest: resolved.suite.inventory.digest,
    preparedEnvironmentDigest: resolved.suite.preparedEnvironmentDigest, expected, scenario,
    runtimeAccountRef: accountRefFor(resolved, target.applicationId, expected.accountProfileId) });
}
