import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  SWEBENCH_DATASETS,
  createTaskUsageTelemetry,
  swebenchAgentLimits,
  swebenchFamily,
  type SwebenchRunResult,
  type SwebenchRunnerConfig,
  type TaskUsageOutcome,
  type TaskUsageTelemetry,
} from "@agentx/contracts";
import { containerBashOperations } from "../devcontainer.js";
import { redactCredentials } from "../events.js";
import { usageForControlPlane } from "../usage.js";
import type { PiSessionAdapter, WorkspaceModelConfiguration } from "../pi-session.js";
import { runSwebenchAgent, type AgentRun } from "./agent.js";
import { copyTestbed, findRepository, pullTaskImage, removeContainer, startTaskContainer, taskContainerExec, TESTBED, type DockerCli } from "./containers.js";
import { datasetRevision, loadSwebenchInstance, type DatasetOptions } from "./dataset.js";
import { gradePrediction, type GradeReport } from "./grade.js";
import { gradeProPrediction } from "./grade-pro.js";
import { gradeSecbenchPrediction, SECBENCH_EVALUATOR_COMMIT, type SecbenchGradeReport } from "./grade-secbench.js";
import { createGitRunner, predictionPatch, SECBENCH_SOURCE_EXTENSIONS, stripHistory, untrackedFiles } from "./history.js";
import { OFFLINE_SETTINGS } from "./offline.js";
import { SECBENCH_PATCH_TEMPLATE_SHA256, SECBENCH_SMOLAGENTS_COMMIT, secbenchPatchPrompt } from "./secbench-prompt.js";
import { loadProTask, type ProTask, type ProTaskOptions } from "./pro-task.js";

export interface RunReporter {
  /** Tells the control plane the agent is about to start. */
  started(): Promise<void>;
  /** Stores one artifact under the run's prefix. */
  artifact(name: string, body: string | Buffer, contentType: string): Promise<void>;
  result(result: SwebenchRunResult): Promise<void>;
}

export interface SwebenchRunDependencies {
  /** Where the run keeps its files; the task container mounts it at the same path. */
  rootPath: string;
  model: WorkspaceModelConfiguration;
  docker: DockerCli;
  reporter: RunReporter;
  log: (event: string, fields?: Record<string, unknown>) => void;
  dataset?: DatasetOptions;
  piAdapter?: PiSessionAdapter;
  grade?: typeof gradePrediction;
  gradePro?: typeof gradeProPrediction;
  gradeSecbench?: typeof gradeSecbenchPrediction;
  proTask?: ProTaskOptions;
  timeLimitMs?: number;
}

/**
 * One SWE-bench run (spec 043 FR-008 to FR-015): load the instance, pull its image, copy the
 * repository out and strip its history, run the agent in the task container, grade the patch, and
 * report. SWE-bench tasks are graded by the official harness; SWE-Bench Pro tasks (spec 044) take
 * their prompt from instruction.md and are graded by their own verifier. SEC-bench patch tasks
 * (spec 045) run in the project's `work_dir` with SEC-bench's own prompt, and are graded by
 * SEC-bench's evaluator. Any failure before grading
 * is reported as a FAILED result; the run never throws once the reporter is reachable.
 */
export async function runSwebench(config: SwebenchRunnerConfig, dependencies: SwebenchRunDependencies): Promise<SwebenchRunResult> {
  const { docker, reporter, log } = dependencies;
  const root = resolve(dependencies.rootPath, config.runId);
  const testbed = resolve(root, "testbed");
  const container = `agentx-swebench-${config.runId}`;
  let agent: AgentRun | undefined;
  let usage: TaskUsageTelemetry | undefined;
  let taskCommit: string | undefined;
  let secbenchRun: { datasetRevision?: string } | undefined;
  const secbenchGrade = resolve(dirname(root), ".secbench-grade", config.runId);
  const saved = new Set<string>();
  const save = async (name: string, body: string | Buffer, contentType: string) => {
    try {
      await reporter.artifact(name, body, contentType);
      saved.add(name);
    } catch (error) {
      log("artifact.failed", { name, error: message(error) });
    }
  };
  let result: SwebenchRunResult;
  try {
    await rm(root, { recursive: true, force: true });
    await mkdir(resolve(root, ".agentx"), { recursive: true });
    const family = swebenchFamily(config.dataset);
    const pro = family === "pro";
    const secbench = family === "secbench";
    const limits = swebenchAgentLimits(config.dataset);
    log("instance.loading", { dataset: config.dataset, instanceId: config.instanceId });
    const instance = await loadSwebenchInstance(config.dataset, config.instanceId, dependencies.dataset);
    if (secbench) {
      const revision = await datasetRevision(SWEBENCH_DATASETS[config.dataset].name, dependencies.dataset);
      secbenchRun = revision === undefined ? {} : { datasetRevision: revision };
      if (revision === undefined) log("dataset.revision_unknown", { dataset: config.dataset });
    }
    // Pro's hidden tests live beside the run's root, never inside it: the task container mounts the root.
    let proTask: ProTask | undefined;
    if (pro) {
      log("task.loading", { instanceId: config.instanceId });
      proTask = await loadProTask(config.instanceId, resolve(dirname(root), ".pro-tasks", config.runId), dependencies.proTask);
      taskCommit = proTask.commit;
    }
    log("image.pulling", { image: instance.image });
    const imageDigest = await pullTaskImage(docker, instance.image);
    // SEC-bench keeps each project at its row's work_dir under /src (spec 045 FR-004).
    const repository = pro ? await findRepository(docker, instance.image) : secbench ? String(instance.work_dir) : TESTBED;
    await copyTestbed(docker, instance.image, testbed, repository);
    const git = createGitRunner(testbed);
    const imageHead = await stripHistory(git, instance.base_commit);
    const untrackedBefore = await untrackedFiles(git);
    await startTaskContainer(docker, { image: instance.image, name: container, rootPath: root, testbedHost: testbed, repository });
    await reporter.started();
    log("agent.starting", { model: `${dependencies.model.provider}/${dependencies.model.modelId}` });
    agent = await runSwebenchAgent({
      rootPath: root,
      model: dependencies.model,
      bashOperations: containerBashOperations(taskContainerExec(docker, container)),
      paths: { hostFolder: testbed, containerFolder: repository },
      problemStatement: proTask?.instruction ?? instance.problem_statement,
      maxCostUsd: config.maxCostUsd,
      timeLimitMs: dependencies.timeLimitMs ?? limits.timeLimitSeconds * 1_000,
      toolCallLimit: limits.toolCallLimit,
      ...(secbench ? { prompt: secbenchPatchPrompt(instance as unknown as { work_dir: string; bug_description: string; sanitizer_report: string }, testbed) } : {}),
      ...(dependencies.piAdapter === undefined ? {} : { piAdapter: dependencies.piAdapter }),
    });
    log("agent.stopped", { stopReason: agent.stopReason, agentSeconds: agent.agentSeconds });
    for (const diagnostic of agent.diagnostics) log("agent.diagnostic", { message: diagnostic });
    usage = sessionUsage(agent, dependencies.model, agent.stopReason === "finished" ? "SUCCEEDED" : "FAILED");
    await removeContainer(docker, container);
    const patch = await predictionPatch(git, imageHead, untrackedBefore, secbench ? SECBENCH_SOURCE_EXTENSIONS : undefined);
    await save("patch.diff", patch, "text/x-diff");
    let grade: GradeReport | SecbenchGradeReport | undefined;
    if (patch.trim().length > 0) {
      log("grading", { patchBytes: Buffer.byteLength(patch) });
      if (secbench) {
        // Outside the run's root, which the agent's container mounts; inside RUN_ROOT, which the
        // runner container mounts at its own path, so the evaluator's bind mounts resolve on the host.
        grade = await (dependencies.gradeSecbench ?? gradeSecbenchPrediction)({ directory: secbenchGrade, instanceId: config.instanceId, patch });
      } else if (proTask === undefined) {
        grade = await (dependencies.grade ?? gradePrediction)({ directory: resolve(root, "grade"), runId: config.runId, instance, patch });
      } else {
        grade = await (dependencies.gradePro ?? gradeProPrediction)({
          directory: resolve(dirname(root), ".pro-tasks", config.runId, "grade"),
          image: instance.image,
          testsDirectory: proTask.testsDirectory,
          patch,
          verifierTimeoutSeconds: proTask.verifierTimeoutSeconds,
        }, docker);
      }
      for (const file of grade.files) {
        const body = await readFile(file.path).catch(() => undefined);
        if (body !== undefined) await save(file.name, body, file.name.endsWith(".json") ? "application/json" : "text/plain");
      }
    }
    result = {
      outcome: "GRADED",
      resolved: grade?.resolved ?? false,
      stopReason: agent.stopReason,
      ...(agent.detail === undefined ? {} : { stopDetail: agent.detail.slice(0, 500) }),
      patchBytes: Buffer.byteLength(patch),
      ...(grade === undefined ? {} : "secbench" in grade ? { secbench: grade.secbench } : { failToPass: grade.failToPass, passToPass: grade.passToPass }),
      agentSeconds: agent.agentSeconds,
      toolCalls: agent.toolCalls,
      imageDigest,
      usage,
      artifactsPrefix: config.artifactsPrefix,
    };
  } catch (error) {
    log("run.failed", { error: message(error) });
    // What SEC-bench's evaluator logged before it failed, kept before its folder is removed (FR-011).
    for (const name of ["evaluator.log", "container.log"]) {
      if (saved.has(`harness/${name}`)) continue;
      const body = await readFile(resolve(secbenchGrade, name)).catch(() => undefined);
      if (body !== undefined) await save(`harness/${name}`, body, "text/plain");
    }
    if (agent !== undefined) usage ??= sessionUsage(agent, dependencies.model, "FAILED");
    result = {
      outcome: "FAILED",
      error: String(redactCredentials(message(error))).slice(0, 2_000),
      ...(usage === undefined ? {} : { usage }),
      artifactsPrefix: config.artifactsPrefix,
    };
  } finally {
    await removeContainer(docker, container);
    await rm(resolve(dirname(root), ".pro-tasks", config.runId), { recursive: true, force: true }).catch(() => undefined);
    await rm(secbenchGrade, { recursive: true, force: true }).catch(() => undefined);
  }
  // The level the session actually ran with, read before the session is disposed; never the requested
  // one. result.json is not parsed by the broker, so it records even a level outside AgentX's six.
  const thinkingLevel = agent?.session.piThinkingLevel?.() ?? agent?.session.getModel().thinkingLevel;
  if (agent !== undefined) {
    const transcript = await readFile(agent.session.sessionFile).catch(() => undefined);
    if (transcript !== undefined) await save("transcript.jsonl", transcript, "application/x-ndjson");
    agent.session.dispose();
  }
  // The offline settings go in the artifact only: the broker's result schema is strict, and the
  // runner image can ship before a broker that knows a new field.
  await save("result.json", JSON.stringify({
    ...result,
    dataset: config.dataset,
    ...(taskCommit === undefined ? {} : { taskCommit }),
    offlineSettings: [...OFFLINE_SETTINGS],
    // Spec 051 Ruling F: what the session reported without failing (an extension's error), already redacted.
    ...(agent === undefined || agent.diagnostics.length === 0 ? {} : { diagnostics: agent.diagnostics }),
    // What a later comparison needs to know about how the run was set up (pilot lesson, 2026-10-01).
    limits: swebenchAgentLimits(config.dataset),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(secbenchRun === undefined ? {} : {
      secbenchSetup: {
        promptTemplateSha256: SECBENCH_PATCH_TEMPLATE_SHA256,
        smolagentsCommit: SECBENCH_SMOLAGENTS_COMMIT,
        evaluatorCommit: SECBENCH_EVALUATOR_COMMIT,
        ...secbenchRun,
      },
    }),
    artifacts: [...saved].sort(),
  }, null, 2), "application/json");
  // result.json above keeps the level in usage; the callback carries it only when the config did.
  const reported = result.usage === undefined ? result : { ...result, usage: usageForControlPlane(result.usage, dependencies.model) };
  await reporter.result(reported);
  return reported;
}

function sessionUsage(agent: AgentRun, model: WorkspaceModelConfiguration, outcome: TaskUsageOutcome): TaskUsageTelemetry {
  return createTaskUsageTelemetry(agent.session.getSessionStats(), {
    ...agent.session.getModel(),
    ...(model.cacheRetention === undefined ? {} : { cacheRetention: model.cacheRetention }),
  }, outcome);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
