import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runCollected, type CollectedProcess, type CollectedProcessOptions } from "../collected-process.js";
import type { SwebenchInstance } from "./dataset.js";

/** The official harness, pinned (FR-014). */
export const SWEBENCH_HARNESS_VERSION = "5.0.2";
/** The name the prediction carries; the harness writes its logs under it. */
export const PREDICTION_MODEL_NAME = "agentx";
/** The harness's own limit on the tests' run, in seconds. */
const TEST_TIMEOUT_SECONDS = 1_800;

export interface GradeReport {
  resolved: boolean;
  failToPass: { passed: number; total: number };
  passToPass: { passed: number; total: number };
  /** The harness's files for the run's artifacts: report.json, test_output.txt, run_instance.log. */
  files: Array<{ name: string; path: string }>;
}

export type ProcessRunner = (executable: string, args: readonly string[], options?: CollectedProcessOptions) => Promise<CollectedProcess>;

/**
 * Grades one prediction with the official SWE-bench harness, installed with uv into a virtualenv
 * under `directory`. The harness reads the instance's row from a local file, starts a fresh
 * container from the task image through the host's Docker, applies the patch and the hidden
 * tests, and writes its report.
 */
export async function gradePrediction(
  input: { directory: string; runId: string; instance: SwebenchInstance; patch: string },
  run: ProcessRunner = (executable, args, options) => runCollected(executable, args, options ?? {}),
): Promise<GradeReport> {
  const { directory, runId, instance } = input;
  await mkdir(directory, { recursive: true });
  const datasetPath = resolve(directory, "instance.json");
  const predictionsPath = resolve(directory, "predictions.jsonl");
  await writeFile(datasetPath, JSON.stringify([instance]));
  await writeFile(predictionsPath, `${JSON.stringify({ instance_id: instance.instance_id, model_name_or_path: PREDICTION_MODEL_NAME, model_patch: input.patch })}\n`);
  const venv = resolve(directory, "venv");
  await required(run("uv", ["venv", "--quiet", "--python", "python3", venv], { timeoutMs: 5 * 60_000 }), "create the harness's virtualenv");
  await required(run("uv", ["pip", "install", "--quiet", "--python", resolve(venv, "bin/python"), `swebench==${SWEBENCH_HARNESS_VERSION}`], { timeoutMs: 10 * 60_000 }), "install the SWE-bench harness");
  const harness = await run(resolve(venv, "bin/python"), [
    "-m", "swebench.harness.run_evaluation",
    "--dataset_name", datasetPath,
    "--split", "test",
    "--instance_ids", instance.instance_id,
    "--predictions_path", predictionsPath,
    "--max_workers", "1",
    "--timeout", String(TEST_TIMEOUT_SECONDS),
    "--run_id", runId,
    "--report_dir", directory,
  ], { cwd: directory, timeoutMs: (TEST_TIMEOUT_SECONDS + 30 * 60) * 1_000 });
  const logDirectory = resolve(directory, "logs/run_evaluation", runId, PREDICTION_MODEL_NAME, instance.instance_id);
  const reportPath = resolve(logDirectory, "report.json");
  let report: unknown;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch {
    const detail = (harness.stderr || harness.stdout).trim().split("\n").slice(-8).join(" ").slice(0, 1_000);
    throw new Error(`the SWE-bench harness wrote no report (exit ${String(harness.exitCode)}): ${detail}`);
  }
  return {
    ...parseHarnessReport(report, instance.instance_id),
    files: ["report.json", "test_output.txt", "run_instance.log"].map((name) => ({ name: `harness/${name}`, path: resolve(logDirectory, name) })),
  };
}

/** The harness's report.json for one instance, as resolved and the two test counts. */
export function parseHarnessReport(value: unknown, instanceId: string): Omit<GradeReport, "files"> {
  const entry = value && typeof value === "object" ? (value as Record<string, unknown>)[instanceId] : undefined;
  if (!entry || typeof entry !== "object") throw new Error(`the harness report has no entry for ${instanceId}`);
  const report = entry as { resolved?: unknown; patch_successfully_applied?: unknown; tests_status?: Record<string, { success?: unknown; failure?: unknown }> };
  if (typeof report.resolved !== "boolean") throw new Error("the harness report does not say whether the instance was resolved");
  const count = (key: "FAIL_TO_PASS" | "PASS_TO_PASS") => {
    const status = report.tests_status?.[key];
    const passed = Array.isArray(status?.success) ? status.success.length : 0;
    const failed = Array.isArray(status?.failure) ? status.failure.length : 0;
    return { passed, total: passed + failed };
  };
  return { resolved: report.resolved, failToPass: count("FAIL_TO_PASS"), passToPass: count("PASS_TO_PASS") };
}

async function required(result: Promise<CollectedProcess>, what: string): Promise<void> {
  const completed = await result;
  if (completed.exitCode !== 0) {
    throw new Error(`could not ${what}: ${(completed.stderr || completed.stdout).trim().split("\n").slice(-5).join(" ").slice(0, 800)}`);
  }
}
