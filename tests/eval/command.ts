import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";
import { EVAL_ROOT, loadCases } from "./case.js";
import { scriptExpectedAnswers } from "./offline.js";
import { compareWithBaseline, EvalReportSchema, reportPath, runEvaluation, type EvalOptions, type EvalReport, type Presentation } from "./runner.js";

export const EVAL_USAGE = "npm run eval -- [--live [--model <id>] [--provider <id>] [--update-baseline]] [--repeat <n>] [--presentation new|legacy] [--cases <dir>]";

export interface EvalArguments {
  /** Only a live run calls a model; without --live the faux provider answers. */
  live: boolean;
  model: EvalOptions["model"];
  presentation: Presentation;
  repeat: number;
  cases?: string;
  updateBaseline: boolean;
}

export function parseEvalArguments(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): EvalArguments {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      live: { type: "boolean", default: false },
      model: { type: "string" },
      provider: { type: "string" },
      repeat: { type: "string" },
      presentation: { type: "string", default: "new" },
      cases: { type: "string" },
      "update-baseline": { type: "boolean", default: false },
    },
  });
  if (!values.live) {
    const liveOnly = [values.model === undefined ? [] : ["--model"], values.provider === undefined ? [] : ["--provider"], values["update-baseline"] ? ["--update-baseline"] : []].flat();
    if (liveOnly.length > 0) throw new Error(`${liveOnly.join(", ")} need --live: a live run calls a paid model with your credentials. Usage: ${EVAL_USAGE}`);
  }
  const repeat = values.repeat === undefined ? (values.live ? 3 : 1) : Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) throw new Error("--repeat must be from 1 through 10");
  if (values.presentation !== "new" && values.presentation !== "legacy") throw new Error("--presentation must be new or legacy");
  const model = values.live
    ? { provider: values.provider ?? env.AGENTX_ORCHESTRATOR_PROVIDER ?? "amazon-bedrock", modelId: values.model ?? env.AGENTX_ORCHESTRATOR_MODEL ?? "amazon.nova-pro-v1:0" }
    : FAUX_MODEL;
  return {
    live: values.live,
    model,
    presentation: values.presentation,
    repeat,
    ...(values.cases === undefined ? {} : { cases: values.cases }),
    updateBaseline: values["update-baseline"],
  };
}

export interface EvalCommandOutcome { report: EvalReport; exitCode: number; lines: string[] }

/** Runs `npm run eval`. Results always go to <root>/results; a baseline is written only by a clean live run with --update-baseline. */
export async function runEvalCommand(argv: readonly string[], options: { root?: string; env?: NodeJS.ProcessEnv } = {}): Promise<EvalCommandOutcome> {
  const root = options.root ?? EVAL_ROOT;
  const parsed = parseEvalArguments(argv, options.env);
  const cases = await loadCases(parsed.cases);
  let report: EvalReport;
  if (parsed.live) {
    report = await runEvaluation(cases, { model: parsed.model, presentation: parsed.presentation, repeat: parsed.repeat, live: true });
  } else {
    const { modelRuntime, faux } = await fauxModelRuntime();
    report = await runEvaluation(cases, { model: parsed.model, modelRuntime, presentation: parsed.presentation, repeat: parsed.repeat, beforeRun: scriptExpectedAnswers(faux) });
  }
  const results = reportPath("results", report.model, parsed.presentation, root);
  await mkdir(dirname(results), { recursive: true });
  await writeFile(results, `${JSON.stringify(report, null, 2)}\n`);
  const { summary } = report;
  const scope = parsed.live
    ? `${parsed.presentation} presentation on ${report.model}`
    : `Offline run on the faux provider (each case answered as expected; no model was called), ${parsed.presentation} presentation`;
  const lines = [
    `${scope}: ${summary.passed}/${summary.cases} cases passed; tool accuracy ${(summary.toolAccuracy * 100).toFixed(1)}%; ` +
      `refusal accuracy ${(summary.refusalAccuracy * 100).toFixed(1)}% over ${summary.refusalCases} cases; ${summary.errors} cases errored. Results: ${results}`,
    ...report.cases.filter((entry) => !entry.passed).map((result) =>
      `  failed ${result.id}: ${result.runs.map((run) => run.error === undefined ? run.tool ?? "no tool" : `error: ${run.error}`).join(", ")}`),
  ];
  if (report.stopped !== undefined) lines.push(`Stopped: ${report.stopped}. Not run: ${report.notRun?.join(", ") || "none"}.`);
  if (!parsed.live) {
    // The oracle answers every case correctly, so any failure here is a harness or fixture fault.
    return { report, exitCode: summary.passed === summary.cases ? 0 : 1, lines };
  }
  const recorded = await recordLiveReport(report, { updateBaseline: parsed.updateBaseline, root });
  return { report, exitCode: recorded.exitCode, lines: [...lines, ...recorded.lines] };
}

/**
 * The live run's verdict. A run with an errored case fails and never becomes a baseline; a baseline
 * that is malformed or was recorded for another provider, model or presentation is an error.
 */
export async function recordLiveReport(report: EvalReport, options: { updateBaseline: boolean; root?: string }): Promise<{ exitCode: number; lines: string[] }> {
  const root = options.root ?? EVAL_ROOT;
  const lines: string[] = [];
  // A stopped run always has an errored case (the one that did not stop), so it fails below too.
  const errored = Math.max(report.summary.errors, report.stopped === undefined ? 0 : 1);
  const erroredText = `${errored} case${errored === 1 ? "" : "s"} errored`;
  const baselinePath = reportPath("baseline", report.model, report.presentation, root);
  if (options.updateBaseline) {
    if (errored > 0) return { exitCode: 1, lines: [`Baseline not written: ${erroredText}. Rerun once the errors are resolved.`] };
    await mkdir(dirname(baselinePath), { recursive: true });
    await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
    return { exitCode: 0, lines: [`Baseline written: ${baselinePath}`] };
  }
  const baseline = await readBaseline(baselinePath, report);
  if (baseline === undefined) lines.push(`No baseline at ${baselinePath}; run again with --update-baseline to record one.`);
  const { regressions, failed } = compareWithBaseline(report, baseline);
  if (regressions.length > 0) lines.push(`Regressed against the baseline: ${regressions.join(", ")}`);
  if (errored > 0) lines.push(`The run failed: ${erroredText}.`);
  return { exitCode: failed || errored > 0 ? 1 : 0, lines };
}

async function readBaseline(path: string, report: EvalReport): Promise<EvalReport | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read the baseline ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`baseline ${path} is malformed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const parsed = EvalReportSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`baseline ${path} is malformed: ${issue ? `${issue.path.join(".") || "report"}: ${issue.message}` : "invalid report"}`);
  }
  const baseline = parsed.data;
  if (baseline.provider !== report.provider || baseline.model !== report.model || baseline.presentation !== report.presentation) {
    throw new Error(`baseline ${path} (${baseline.provider}/${baseline.model}, ${baseline.presentation} presentation) does not match this run ` +
      `(${report.provider}/${report.model}, ${report.presentation} presentation)`);
  }
  return baseline;
}
