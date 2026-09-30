import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  SWEBENCH_AGENT_TIME_LIMIT_SECONDS,
  createTaskUsageTelemetry,
  type SwebenchRunResult,
  type SwebenchRunnerConfig,
  type TaskUsageOutcome,
  type TaskUsageTelemetry,
} from "@agentx/contracts";
import { containerBashOperations } from "../devcontainer.js";
import { redactCredentials } from "../events.js";
import type { PiSessionAdapter, WorkspaceModelConfiguration } from "../pi-session.js";
import { runSwebenchAgent, type AgentRun } from "./agent.js";
import { copyTestbed, pullTaskImage, removeContainer, startTaskContainer, taskContainerExec, TESTBED, type DockerCli } from "./containers.js";
import { loadSwebenchInstance, type DatasetOptions } from "./dataset.js";
import { gradePrediction, type GradeReport } from "./grade.js";
import { createGitRunner, predictionPatch, stripHistory, untrackedFiles } from "./history.js";

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
  timeLimitMs?: number;
}

/**
 * One SWE-bench run (spec 043 FR-008 to FR-015): load the instance, pull its image, copy /testbed
 * out and strip its history, run the agent in the task container, grade the patch with the official
 * harness, and report. Any failure before grading is reported as a FAILED result; the run never
 * throws once the reporter is reachable.
 */
export async function runSwebench(config: SwebenchRunnerConfig, dependencies: SwebenchRunDependencies): Promise<SwebenchRunResult> {
  const { docker, reporter, log } = dependencies;
  const root = resolve(dependencies.rootPath, config.runId);
  const testbed = resolve(root, "testbed");
  const container = `agentx-swebench-${config.runId}`;
  let agent: AgentRun | undefined;
  let usage: TaskUsageTelemetry | undefined;
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
    log("instance.loading", { dataset: config.dataset, instanceId: config.instanceId });
    const instance = await loadSwebenchInstance(config.dataset, config.instanceId, dependencies.dataset);
    log("image.pulling", { image: instance.image });
    const imageDigest = await pullTaskImage(docker, instance.image);
    await copyTestbed(docker, instance.image, testbed);
    const git = createGitRunner(testbed);
    const imageHead = await stripHistory(git, instance.base_commit);
    const untrackedBefore = await untrackedFiles(git);
    await startTaskContainer(docker, { image: instance.image, name: container, rootPath: root, testbedHost: testbed });
    await reporter.started();
    log("agent.starting", { model: `${dependencies.model.provider}/${dependencies.model.modelId}` });
    agent = await runSwebenchAgent({
      rootPath: root,
      model: dependencies.model,
      bashOperations: containerBashOperations(taskContainerExec(docker, container)),
      paths: { hostFolder: testbed, containerFolder: TESTBED },
      problemStatement: instance.problem_statement,
      maxCostUsd: config.maxCostUsd,
      timeLimitMs: dependencies.timeLimitMs ?? SWEBENCH_AGENT_TIME_LIMIT_SECONDS * 1_000,
      ...(dependencies.piAdapter === undefined ? {} : { piAdapter: dependencies.piAdapter }),
    });
    log("agent.stopped", { stopReason: agent.stopReason, agentSeconds: agent.agentSeconds });
    usage = sessionUsage(agent, dependencies.model, agent.stopReason === "finished" ? "SUCCEEDED" : "FAILED");
    await removeContainer(docker, container);
    const patch = await predictionPatch(git, imageHead, untrackedBefore);
    await save("patch.diff", patch, "text/x-diff");
    let grade: GradeReport | undefined;
    if (patch.trim().length > 0) {
      log("grading", { patchBytes: Buffer.byteLength(patch) });
      grade = await (dependencies.grade ?? gradePrediction)({ directory: resolve(root, "grade"), runId: config.runId, instance, patch });
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
      ...(grade === undefined ? {} : { failToPass: grade.failToPass, passToPass: grade.passToPass }),
      agentSeconds: agent.agentSeconds,
      imageDigest,
      usage,
      artifactsPrefix: config.artifactsPrefix,
    };
  } catch (error) {
    log("run.failed", { error: message(error) });
    if (agent !== undefined) usage ??= sessionUsage(agent, dependencies.model, "FAILED");
    result = {
      outcome: "FAILED",
      error: String(redactCredentials(message(error))).slice(0, 2_000),
      ...(usage === undefined ? {} : { usage }),
      artifactsPrefix: config.artifactsPrefix,
    };
  } finally {
    await removeContainer(docker, container);
  }
  if (agent !== undefined) {
    const transcript = await readFile(agent.session.sessionFile).catch(() => undefined);
    if (transcript !== undefined) await save("transcript.jsonl", transcript, "application/x-ndjson");
    agent.session.dispose();
  }
  await save("result.json", JSON.stringify({ ...result, artifacts: [...saved].sort() }, null, 2), "application/json");
  await reporter.result(result);
  return result;
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
