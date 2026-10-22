import { dockerOwnedResourceInventory, assembleDockerCollectionInputs, assembleExecutorActualRun, readExecutorResultFile, snapshotExecutorOutput, type DockerCollectionInputs,
  type ExecutorOutputSnapshot } from "../../packages/verifier/src/host/executor-readback.js";
import { buildE2EAgentModelEvidence } from "../../packages/verifier/src/host/agent-model-evidence.js";
import { resolveE2EExecutorSuite } from "../../packages/verifier/src/executor/suite.js";
import type { E2EAgentModelEvidence } from "../../packages/verifier/src/application-agent-result.js";
import { collectE2EApplicationRun } from "../../packages/verifier/src/application-collection.js";
import type { AgentRun } from "./agent-executor-run.js";
import { withModelChannel } from "./orders-m14-agent.js";

/** A real agent run (the real executor, Chromium, the scripted model through the worker's proxy) read back the way the Docker host reads it. */
export type AssembledAgentRun = Awaited<ReturnType<typeof assembleAgentRun>>;

export async function assembleAgentRun(run: AgentRun) {
  const snapshot: ExecutorOutputSnapshot = await snapshotExecutorOutput(run.out, await readExecutorResultFile(run.out));
  const plan = withModelChannel(run.fixture.plan, run.valueKey);
  const resolved = resolveE2EExecutorSuite(plan);
  const inventory = dockerOwnedResourceInventory(resolved.binding.runId, []);
  const cleanup = { removedAt: new Date().toISOString(), containers: inventory.containers, network: inventory.network, mockOrigins: [] as string[] };
  const actual = assembleExecutorActualRun({ snapshot, compiled: resolved.suite, binding: resolved.binding, cleanup, evidenceDirectory: "/out" });
  const base = assembleDockerCollectionInputs({ snapshot, binding: resolved.binding, cleanup });
  // What the Docker host adds for a group with an agent step.
  const agentModel = buildE2EAgentModelEvidence({ closed: run.closed, valueKey: run.valueKey, agent: snapshot.executorEvidence.agent });
  const inputs: DockerCollectionInputs = { ...base, agentModel };
  return { run, snapshot, plan, resolved, cleanup, actual, inputs, agentModel };
}

/** The post-close join the worker performs: the host's actual run and protected inputs through the real collector, with `inputs` replaced as a test needs. */
export function collectAssembled(assembled: AssembledAgentRun, inputs: DockerCollectionInputs | (Omit<DockerCollectionInputs, "agentModel"> & { agentModel?: E2EAgentModelEvidence | null }) = assembled.inputs) {
  const { resolved } = assembled;
  return collectE2EApplicationRun({ actual: assembled.actual, compiled: resolved.suite, binding: resolved.binding, round: resolved.round, ...inputs } as never);
}

/** The first case's result in a collection, or undefined when the collector gave none. */
export const firstCase = (collected: ReturnType<typeof collectAssembled>) => collected.qualification?.result?.cases[0];
