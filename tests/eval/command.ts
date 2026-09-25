import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";
import { EVAL_ROOT, loadCases } from "./case.js";
import { scriptExpectedAnswers } from "./offline.js";
import { compareWithBaseline, reportPath, runEvaluation, type EvalOptions, type EvalReport, type Presentation } from "./runner.js";

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

/** Runs `npm run eval`. Results always go to <root>/results; a baseline is written only by a live run with --update-baseline. */
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
  if (!parsed.live) {
    // The oracle answers every case correctly, so any failure here is a harness or fixture fault.
    return { report, exitCode: summary.passed === summary.cases ? 0 : 1, lines };
  }
  const baselinePath = reportPath("baseline", report.model, parsed.presentation, root);
  if (parsed.updateBaseline) {
    await mkdir(dirname(baselinePath), { recursive: true });
    await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
    lines.push(`Baseline written: ${baselinePath}`);
    return { report, exitCode: 0, lines };
  }
  let baseline: EvalReport | undefined;
  try {
    baseline = JSON.parse(await readFile(baselinePath, "utf8")) as EvalReport;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`cannot read the baseline ${baselinePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    lines.push(`No baseline at ${baselinePath}; run again with --update-baseline to record one.`);
  }
  const { regressions, failed } = compareWithBaseline(report, baseline);
  if (regressions.length > 0) lines.push(`Regressed against the baseline: ${regressions.join(", ")}`);
  return { report, exitCode: failed ? 1 : 0, lines };
}
