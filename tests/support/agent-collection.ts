import { dockerOwnedResourceInventory, assembleDockerCollectionInputs, assembleExecutorActualRun, readExecutorResultFile, snapshotExecutorOutput, type DockerCollectionInputs,
  type ExecutorOutputSnapshot } from "../../packages/verifier/src/host/executor-readback.js";
import { agentTraceGroupOf, buildE2EAgentModelEvidence } from "../../packages/verifier/src/host/agent-model-evidence.js";
import { resolveE2EExecutorSuite } from "../../packages/verifier/src/executor/suite.js";
import type { E2EApplicationCollectionResult } from "../../packages/verifier/src/application-result-adapter.js";
import type { E2EAgentModelEvidence } from "../../packages/verifier/src/application-agent-result.js";
import { collectE2EApplicationRun } from "../../packages/verifier/src/application-collection.js";
import type { AgentRun } from "./agent-executor-run.js";
import { withModelChannel } from "./orders-m14-agent.js";
import { createHash } from "node:crypto";
import { e2eCompiledRuntime } from "../../packages/verifier/src/application-scenarios.js";
import type { E2EApplicationExecutionAdmission, E2EModelRouteDefinition } from "@agentx/contracts";
import { scriptedE2ERouteDefinition } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { encodeE2EApplicationExecutionAdmission, validateE2EApplicationExecutionAdmission } from "../../packages/verifier/src/application-scenarios.js";
import { verifyApplicationE2EEvidence, type ApplicationEvidenceInput, type ApplicationEvidenceVerification } from "../../packages/broker/src/e2e/application-evidence.js";
import { aggregateEvidenceEnvelope, groupEvidenceEnvelope } from "./e2e-application-evidence-fixture.js";

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
  const agentModel = buildE2EAgentModelEvidence({ closed: run.closed, valueKey: run.valueKey, agent: snapshot.executorEvidence.agent, group: agentTraceGroupOf(resolved.suite, resolved.binding.runId) });
  const inputs: DockerCollectionInputs = { ...base, agentModel };
  return { run, snapshot, plan, resolved, cleanup, actual, inputs, agentModel };
}

/** The post-close join the worker performs: the host's actual run and protected inputs through the real collector, with `inputs` replaced as a test needs. */
export function collectAssembled(assembled: AssembledAgentRun, inputs: DockerCollectionInputs | (Omit<DockerCollectionInputs, "agentModel"> & { agentModel?: E2EAgentModelEvidence | null }) = assembled.inputs): E2EApplicationCollectionResult {
  const { resolved } = assembled;
  return collectE2EApplicationRun({ actual: assembled.actual, compiled: resolved.suite, binding: resolved.binding, round: resolved.round, ...inputs });
}

/** The first case's result in a collection, or undefined when the collector gave none. */
export const firstCase = (collected: E2EApplicationCollectionResult) => collected.qualification?.result?.cases[0];

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The broker's side: the same real run as the group evidence the worker would upload, and the verification the broker makes of it.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The route the broker reads from its registry for the scripted route's revision (a route the registry holds is a standard-scope one; the scripted double's is a qualification one). */
export const SCRIPTED_REGISTRY_ROUTE = scriptedE2ERouteDefinition();

export type BrokerRound = { admission: E2EApplicationExecutionAdmission; binding: E2EApplicationExecutionAdmission["groups"][number]["outerBinding"]; collected: E2EApplicationCollectionResult;
  groupRun: Record<string, unknown>; input: ApplicationEvidenceInput; verify(): ApplicationEvidenceVerification };

/**
 * The run as a Linux executor in the pinned image leaves it. The runs these tests make are on this machine, so the runner's own report names this machine's environment (macOS), which the
 * broker holds to the admitted runtime's (Linux). Rewrites the report's environment to that, with the digest the process record keeps of the report and the inputs' copy, and nothing
 * else: the limits (the model ceiling the config pins), the receipts, ledgers, captures and cleanup are the real ones.
 */
export function asLinuxRun(a: AssembledAgentRun): AssembledAgentRun {
  const environment = e2eCompiledRuntime(a.resolved.suite)!.runnerEnvironment;
  const shards = a.actual.shards.map((shard) => {
    const report = JSON.parse(Buffer.from(shard.rawReportBytes).toString("utf8")) as { run: { environment: unknown } };
    report.run.environment = environment;
    const bytes = Buffer.from(JSON.stringify(report));
    return { ...shard, rawReportBytes: bytes, runProcess: { ...shard.runProcess, stdoutSha256: createHash("sha256").update(bytes).digest("hex"), stdoutBytes: bytes.byteLength } };
  });
  return { ...a, actual: { ...a.actual, shards }, inputs: { ...a.inputs, environment } };
}

export function brokerRoundFor(a: AssembledAgentRun, options: { inputs?: Parameters<typeof collectAssembled>[1]; modelRouteDefinition?: E2EModelRouteDefinition | null | undefined; terminalStatus?: "SUCCEEDED" | "FAILED";
  editGroupRun?: (groupRun: Record<string, unknown>) => void } = {}): BrokerRound {
  const admission: E2EApplicationExecutionAdmission = a.run.fixture.plan.admission;
  const validated = validateE2EApplicationExecutionAdmission(admission);
  const binding = admission.groups[0]!.outerBinding;
  const inputs = options.inputs ?? a.inputs;
  const collected = collectAssembled(a, inputs);
  const planGroup = validated.executionPlan.groups.find((item) => item.groupId === binding.groupId);
  // As the worker packs it: the collection it qualified, the inputs it read, the host's own account of how the process ended.
  const qualified = collected.qualification !== null;
  const reason = qualified ? (collected.qualification.status === "UNKNOWN" ? collected.qualification.reason : null) : collected.unavailableReason ?? "application collection unavailable";
  const groupRun = JSON.parse(JSON.stringify({ kind: "application", group: planGroup, binding, collection: collected.qualification ?? { status: "UNKNOWN", reason }, unavailableReason: reason,
    lifecycle: { cleanup: "confirmed", process: { exitCode: a.run.result.exitCode, timedOut: false, aborted: false } },
    actual: qualified ? { collection: collected.collection, collectionInputs: inputs } : null, diagnostics: null, operatorEvidence: null })) as Record<string, unknown>;
  options.editGroupRun?.(groupRun);
  const admissionBytes = Buffer.from(encodeE2EApplicationExecutionAdmission(admission), "utf8");
  const admissionSha256 = createHash("sha256").update(admissionBytes).digest("hex");
  // The broker's own receipt time of the group's evidence: after the run's resources were removed, inside the harvest window.
  const receivedAt = new Date(Date.parse(a.cleanup.removedAt) + 2_000).toISOString();
  const routeDefinition = "modelRouteDefinition" in options ? options.modelRouteDefinition : SCRIPTED_REGISTRY_ROUTE;
  const input: ApplicationEvidenceInput = { admissionBytes,
    subject: { taskId: admission.taskId, operationId: admission.operationId, operationFence: admission.operationFence, workflowRevision: admission.workflowRevision,
      candidateDigest: admission.candidateDigest, roundId: admission.round.roundId, groupRunIds: [binding.runId], admissionSha256 },
    aggregate: aggregateEvidenceEnvelope({ admission, admissionSha256, groupRuns: [groupRun] }),
    groupEvidence: new Map([[binding.runId, groupEvidenceEnvelope({ admission, admissionSha256, groupRun })]]), receivedAt: new Map([[binding.runId, receivedAt]]),
    terminalStatus: options.terminalStatus ?? "SUCCEEDED",
    ...(routeDefinition === undefined ? {} : { modelRouteDefinition: routeDefinition }) };
  return { admission, binding, collected, groupRun, input, verify: () => verifyApplicationE2EEvidence(input) };
}
