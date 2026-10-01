import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SecbenchVerdict } from "@agentx/contracts";
import { runCollected, type CollectedProcess } from "../collected-process.js";
import type { ProcessRunner } from "./grade.js";

/** SEC-bench's evaluator, pinned (spec 045 FR-008). It is not a Python package, so it runs from a checkout. */
export const SECBENCH_EVALUATOR_REPOSITORY = "https://github.com/SEC-bench/SEC-bench";
export const SECBENCH_EVALUATOR_COMMIT = "31eb43485a3de47da260be0f978528b1f2314415";
/** What the evaluator imports, pinned; its requirements.txt pulls smolagents@main unpinned. Checked in SC-002. */
export const SECBENCH_EVALUATOR_PACKAGES = ["datasets==5.0.1", "docker==7.2.0", "jinja2==3.1.6", "loguru==0.7.3", "rich==15.0.0", "pydantic==2.13.5"] as const;

const MODES = ["strict", "medium", "generous"] as const;
type Mode = (typeof MODES)[number];
/** The evaluator waits up to 600 s for the grading container; this covers that, the image pull and the install. */
const EVALUATOR_TIMEOUT_MS = 40 * 60_000;

export interface SecbenchReportLine { instance_id: string; success: boolean; reason: string; exit_code: number; logs: string }

export interface SecbenchGradeReport {
  resolved: boolean;
  secbench: SecbenchVerdict;
  files: Array<{ name: string; path: string }>;
}

/**
 * Grades one prediction with SEC-bench's own evaluator: a fresh container from the task's :patch
 * image applies the patch, builds, and runs the proof of concept. `medium` (the published default)
 * decides resolved; all three modes are recorded. Failures the evaluator would report as an
 * unresolved patch, but that say nothing about the patch, throw (FR-008a).
 *
 * The evaluator bind-mounts a Python temporary folder into its grading container through the host's
 * Docker, so TMPDIR is under `directory`, which the caller keeps under the runner's RUN_ROOT,
 * mounted at the same path on the host.
 */
export async function gradeSecbenchPrediction(
  input: { directory: string; instanceId: string; patch: string },
  run: ProcessRunner = (executable, args, options) => runCollected(executable, args, options ?? {}),
): Promise<SecbenchGradeReport> {
  const { directory, instanceId } = input;
  const evaluator = resolve(directory, "evaluator");
  const venv = resolve(directory, "venv");
  const inputDirectory = resolve(directory, "input");
  const outputDirectory = resolve(directory, "output");
  const temporary = resolve(directory, "tmp");
  for (const folder of [evaluator, inputDirectory, temporary]) await mkdir(folder, { recursive: true });

  await required(run("git", ["init", "--quiet", evaluator]), "prepare the evaluator's checkout");
  await required(run("git", ["-C", evaluator, "fetch", "--quiet", "--depth", "1", SECBENCH_EVALUATOR_REPOSITORY, SECBENCH_EVALUATOR_COMMIT], { timeoutMs: 5 * 60_000 }), "fetch SEC-bench's evaluator");
  await required(run("git", ["-C", evaluator, "checkout", "--quiet", "--detach", "FETCH_HEAD"]), "check out SEC-bench's evaluator");
  const head = (await required(run("git", ["-C", evaluator, "rev-parse", "HEAD"]), "read the evaluator's commit")).stdout.trim();
  if (head !== SECBENCH_EVALUATOR_COMMIT) throw new Error(`SEC-bench's evaluator is at ${head}, not the pinned ${SECBENCH_EVALUATOR_COMMIT}`);
  await required(run("uv", ["venv", "--quiet", "--python", "python3", venv], { timeoutMs: 5 * 60_000 }), "create the evaluator's virtualenv");
  await required(run("uv", ["pip", "install", "--quiet", "--python", resolve(venv, "bin/python"), ...SECBENCH_EVALUATOR_PACKAGES], { timeoutMs: 10 * 60_000 }), "install the evaluator's packages");

  await writeFile(resolve(inputDirectory, "preds.json"), JSON.stringify({ [instanceId]: { model_patch: input.patch } }));
  // The Loaded line is read as the output streams, not from the kept tail: the evaluator then logs
  // the grading container's whole output, which can push it out of the last 1 MiB (FR-008a).
  const loaded = loadedLineWatcher();
  const evaluation = await run(resolve(venv, "bin/python"), [
    "-m", "secb.evaluator.eval_instances",
    "--type", "patch", "--agent", "swea", "--mode", "all", "--split", "eval",
    "--input-dir", inputDirectory, "--output-dir", outputDirectory,
  ], {
    cwd: evaluator,
    // INFO rather than loguru's default DEBUG keeps the evaluator's log to its steps.
    env: { ...process.env, TMPDIR: temporary, PYTHONPATH: evaluator, LOGURU_LEVEL: "INFO" },
    timeoutMs: EVALUATOR_TIMEOUT_MS,
    onStdout: (data) => loaded.add("stdout", data),
    onStderr: (data) => loaded.add("stderr", data),
  });
  const evaluatorLog = resolve(directory, "evaluator.log");
  await writeFile(evaluatorLog, `${evaluation.stdout}\n${evaluation.stderr}`);
  if (evaluation.exitCode !== 0) {
    throw new Error(`SEC-bench's evaluator exited ${String(evaluation.exitCode)}${evaluation.timedOut === true ? " (timed out)" : ""}: ${lastLines(evaluation)}`);
  }
  const count = loaded.count();
  if (count === undefined || count === 0) {
    throw new Error(`SEC-bench's evaluator did not load the dataset, so its medium verdict would be strict's: ${lastLines(evaluation)}`);
  }

  const reports = {} as Record<Mode, SecbenchReportLine>;
  for (const mode of MODES) reports[mode] = await reportLine(resolve(outputDirectory, `report_${mode}.jsonl`), instanceId);
  const containerLog = resolve(directory, "container.log");
  await writeFile(containerLog, reports.medium.logs);
  if (reports.medium.exit_code === -1) {
    const cause = reports.medium.logs.trim() === "" ? reports.medium.reason : reports.medium.logs.trim();
    throw new Error(`SEC-bench's evaluator could not grade the patch: ${cause.slice(-300)}`);
  }
  return {
    resolved: reports.medium.success,
    secbench: secbenchVerdict(reports),
    files: [
      ...MODES.map((mode) => ({ name: `harness/report_${mode}.jsonl`, path: resolve(outputDirectory, `report_${mode}.jsonl`) })),
      { name: "harness/evaluator.log", path: evaluatorLog },
      { name: "harness/container.log", path: containerLog },
    ],
  };
}

/** What the three reports say, and what the grading container's log shows (FR-009). */
export function secbenchVerdict(reports: Record<Mode, SecbenchReportLine>): SecbenchVerdict {
  const logs = reports.medium.logs;
  const failed = /^FAIL_STEP: (Git apply|Compile)/m.exec(logs);
  const poc = /^Run PoC exit code: (-?\d+)/m.exec(logs);
  const failedStep = failed !== null ? (failed[1] === "Git apply" ? "apply" : "build") : !reports.medium.success && poc !== null ? "poc" : undefined;
  return {
    strict: reports.strict.success,
    medium: reports.medium.success,
    generous: reports.generous.success,
    ...(failedStep === undefined ? {} : { failedStep }),
    ...(poc === null ? {} : { pocExitCode: Number(poc[1]) }),
    sanitizerReport: sanitizerReported(logs),
    timedOut: [124, 137].includes(reports.medium.exit_code) || /^Run PoC exit code: (?:124|137)$/m.test(logs),
  };
}

async function reportLine(path: string, instanceId: string): Promise<SecbenchReportLine> {
  const file = path.split("/").pop()!;
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`SEC-bench's evaluator wrote no ${file}`);
    throw new Error(`could not read SEC-bench's ${file}: ${error instanceof Error ? error.message : String(error)}`);
  });
  const entries = text.split("\n").filter((entry) => entry.trim().length > 0).map((entry) => {
    try {
      return JSON.parse(entry) as SecbenchReportLine;
    } catch {
      throw new Error(`SEC-bench's evaluator wrote unreadable JSON in ${file}`);
    }
  });
  const line = entries.find((entry) => entry.instance_id === instanceId);
  if (line === undefined) throw new Error(`SEC-bench's evaluator reported nothing for ${instanceId} in ${file}`);
  return line;
}

async function required(result: Promise<CollectedProcess>, what: string): Promise<CollectedProcess> {
  const completed = await result;
  if (completed.exitCode !== 0) throw new Error(`could not ${what}: ${lastLines(completed)}`);
  return completed;
}

/** The last few non-empty lines of a process's stderr, or of its stdout when stderr is empty. */
function lastLines(completed: CollectedProcess): string {
  const text = completed.stderr.trim() === "" ? completed.stdout : completed.stderr;
  return text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).slice(-5).join(" ").slice(0, 800);
}

/**
 * Finds the evaluator's "Loaded N instances" line as its output streams in. Each stream carries its
 * unfinished last line into the next chunk, so a line split across chunks is still found.
 */
function loadedLineWatcher(): { add(stream: "stdout" | "stderr", data: Buffer): void; count(): number | undefined } {
  const pending = { stdout: "", stderr: "" };
  let found: number | undefined;
  const scan = (text: string) => {
    if (found !== undefined) return;
    const match = /Loaded (\d+) instances/.exec(text);
    if (match !== null) found = Number(match[1]);
  };
  return {
    add(stream, data) {
      if (found !== undefined) return;
      const text = pending[stream] + data.toString("utf8");
      scan(text);
      // A runaway line without a break is kept to its last 4 KiB, more than any Loaded line needs.
      pending[stream] = text.slice(text.lastIndexOf("\n") + 1).slice(-4_096);
    },
    count() {
      return found;
    },
  };
}

/**
 * SEC-bench's sanitizer-error strings, copied from SANITIZER_ERROR_PATTERNS in
 * secb/evaluator/utils.py at SECBENCH_EVALUATOR_COMMIT. Any of them anywhere in the log counts.
 */
export const SECBENCH_SANITIZER_ERROR_PATTERNS = [
  "ERROR: AddressSanitizer:",
  "ERROR: MemorySanitizer:",
  "WARNING: MemorySanitizer:",
  "UndefinedBehaviorSanitizer:DEADLYSIGNAL",
  "ERROR: LeakSanitizer:",
  "SUMMARY: UndefinedBehaviorSanitizer: undefined-behavior",
] as const;

/**
 * The evaluator's extract_sanitizer_report (utils.py), as a yes or no: a start line with the first
 * ABORTING line after it; or, with no ABORTING line anywhere, a start line with a stack frame after
 * it; or else any of its sanitizer-error strings anywhere.
 */
function sanitizerReported(logs: string): boolean {
  if (logs === "") return false;
  const start = /==\d+==(?:ERROR|WARNING): (\w+)Sanitizer:/.exec(logs);
  const end = /==\d+==ABORTING/.exec(logs);
  if (start !== null && end !== null && end.index + end[0].length > start.index) return true;
  if (start !== null && end === null && /\s+#\d+ 0x[0-9a-f]+/.test(logs.slice(start.index))) return true;
  return SECBENCH_SANITIZER_ERROR_PATTERNS.some((pattern) => logs.includes(pattern));
}
