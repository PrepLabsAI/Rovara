// DEC 254zzz43: the setup run DRY-RUNS the wrapper file in its own sandbox before it is offered to anyone. Nothing here touches the repository's files, a network, a model or a secret:
//   - a `rows` wrapper (made by code from the template, `evalWrapperFor`, the SAME text the broker will show) is run in a scratch folder under /tmp against SAMPLE rows in the shape the setup agent described, written by a
//     tiny stand-in command; it must write a JUnit report with one case per sample row, the failing sample row failing and the passing one passing. That proves the described shape (format, id field, pass rule) is read as
//     described. The customer's own eval command is never run (it calls a paid model).
//   - a `custom` wrapper (the setup agent's own text; copy-only) is checked for syntax only (`py_compile` / `node --check`): its command is the customer's, which is not run.
// The result is `passed` or `failed`; only `passed` makes the broker show, copy or open the file. A failure to run at all (no interpreter, a timeout) is `failed`, never a guess. Fixed words; no output is kept or logged.
import { Buffer } from "node:buffer";
import { EvalCommandSchema, EvalOutputShapeSchema, EvalReportPathSchema, evalWrapperFor, type EvalOutputShape } from "@agentx/contracts";

/** Runs one shell command line in the setup sandbox and says how it ended and what it printed (bounded by the caller). */
export type DryRunExec = (command: string, options: { timeoutSeconds: number }) => Promise<{ exitCode: number | null; output: string }>;

const PASS_ID = "rovara-dry-run-pass";
const FAIL_ID = "rovara-dry-run-fail";
const WRAPPER_TIMEOUT_SECONDS = 25;
const MAX_SUITES = 4;

type Rows = Extract<EvalOutputShape, { kind: "rows" }>;

function setDeep(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let at = target;
  for (const part of parts.slice(0, -1)) {
    const next = at[part];
    at = typeof next === "object" && next !== null ? next as Record<string, unknown> : (at[part] = {});
  }
  at[parts[parts.length - 1]!] = value;
}

/** The value that does NOT mean passed, for a pass rule (a different boolean, string or number). */
function failing(rule: Rows["pass"]): boolean | string | number {
  if ("atLeast" in rule) return rule.atLeast - 1;
  const value = rule.equals;
  return typeof value === "boolean" ? !value : typeof value === "number" ? value + 1 : `${value}-not`;
}
const passing = (rule: Rows["pass"]): boolean | string | number => ("atLeast" in rule ? rule.atLeast + 1 : rule.equals);

/** Two sample rows (one that passed, one that did not) in the file format the shape names. Pure. */
export function sampleResultsOf(shape: Rows): string {
  const row = (id: string, pass: boolean | string | number): Record<string, unknown> => { const out: Record<string, unknown> = {}; setDeep(out, shape.idField, id); setDeep(out, shape.pass.field, pass); return out; };
  const rows = [row(PASS_ID, passing(shape.pass)), row(FAIL_ID, failing(shape.pass))];
  if (shape.format === "jsonl") return `${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  if (shape.format === "json") {
    if (shape.rowsKey === undefined) return `${JSON.stringify(rows)}\n`;
    const wrap: Record<string, unknown> = {};
    setDeep(wrap, shape.rowsKey, rows);
    return `${JSON.stringify(wrap)}\n`;
  }
  // csv: the columns are the two fields as the wrapper reads them (a dotted name is a flat column there, so the template cannot read it and the dry-run fails: that is the answer).
  const cell = (value: unknown): string => `"${String(value).replace(/"/gu, '""')}"`;
  const flat = (entry: Record<string, unknown>, dotted: string): unknown => dotted.split(".").reduce<unknown>((value, part) => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[part] : undefined), entry);
  return `${cell(shape.idField)},${cell(shape.pass.field)}\n${rows.map((entry) => `${cell(flat(entry, shape.idField))},${cell(flat(entry, shape.pass.field))}`).join("\n")}\n`;
}

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

/** The one shell line that writes the scratch files, runs the wrapper and prints the report it wrote after a marker. Everything lives in a fresh folder under /tmp that is removed at the end. */
function scratchLine(input: { wrapperPath: string; wrapper: string; language: "python" | "node"; results: string; sample: string }): string {
  const run = input.language === "python" ? "python3" : "node";
  return [
    "D=$(mktemp -d /tmp/rovara-wrapper-dryrun-XXXXXX) || exit 97", "trap 'rm -rf \"$D\"' EXIT", "mkdir -p \"$D/rovara\" || exit 97",
    `printf %s '${b64(input.wrapper)}' | base64 -d > "$D/${input.wrapperPath}" || exit 97`,
    // the stand-in for the customer's command: it writes the sample results where the wrapper reads them
    `printf '%s\\n' 'mkdir -p "$(dirname "${input.results}")"' 'printf %s '"'${b64(input.sample)}'"' | base64 -d > "${input.results}"' > "$D/dryrun-eval.sh"`,
    `(cd "$D" && ${run} "${input.wrapperPath}" >/dev/null 2>&1) || exit 98`,
    "echo ---REPORT---", "cat \"$D/rovara/eval-wrapper-results.xml\"",
  ].join("; ");
}

/** What the report must say: the passing sample passed, the failing one failed, and nothing else. */
export function reportReadsSamples(xml: string): boolean {
  const cases = [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]*)"([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/gu)].map((found) => ({ name: found[1]!, failed: found[3] !== "/>" && /<failure\b/u.test(found[4] ?? "") }));
  return cases.length === 2 && cases.some((entry) => entry.name === PASS_ID && !entry.failed) && cases.some((entry) => entry.name === FAIL_ID && entry.failed);
}

/** Dry-runs the wrapper of ONE suite as the setup agent drafted it. Never throws. */
export async function dryRunEvalWrapper(suite: { output: unknown; command: unknown; report: unknown }, exec: DryRunExec): Promise<"passed" | "failed"> {
  try {
    const output = EvalOutputShapeSchema.safeParse(suite.output);
    const command = EvalCommandSchema.safeParse(suite.command);
    const report = EvalReportPathSchema.safeParse(suite.report);
    if (!output.success || !command.success || !report.success) return "failed";
    const shape = output.data;
    if (shape.kind === "custom") {
      const file = evalWrapperFor({ command: command.data, report: report.data, output: shape });
      if (file === undefined) return "failed";
      const name = shape.language === "python" ? "f.py" : "f.mjs";
      const check = shape.language === "python" ? `python3 -m py_compile "$D/${name}"` : `node --check "$D/${name}"`;
      const line = ["D=$(mktemp -d /tmp/rovara-wrapper-dryrun-XXXXXX) || exit 97", "trap 'rm -rf \"$D\"' EXIT", `printf %s '${b64(file.content)}' | base64 -d > "$D/${name}" || exit 97`, check].join("; ");
      return (await exec(line, { timeoutSeconds: WRAPPER_TIMEOUT_SECONDS })).exitCode === 0 ? "passed" : "failed";
    }
    if (shape.kind !== "rows") return "failed";
    // The same text the broker will offer, but with the stand-in as the command: the shape's own reading is what is proven.
    const standIn = { executable: "sh", args: ["dryrun-eval.sh"], cwd: "." };
    const file = evalWrapperFor({ command: standIn, report: report.data, output: shape });
    if (file === undefined) return "failed";
    const results = report.data.cwd === "." ? report.data.argument : `${report.data.cwd}/${report.data.argument}`;
    const done = await exec(scratchLine({ wrapperPath: file.path, wrapper: file.content, language: file.language, results, sample: sampleResultsOf(shape) }), { timeoutSeconds: WRAPPER_TIMEOUT_SECONDS });
    if (done.exitCode !== 0) return "failed";
    const at = done.output.indexOf("---REPORT---");
    return at >= 0 && reportReadsSamples(done.output.slice(at + "---REPORT---".length)) ? "passed" : "failed";
  } catch { return "failed"; }
}

/** The dry-run of every suite of the agent's draft that has an output needing a wrapper, by the suite's selection. Anything not an object, and any suite that needs no wrapper, is left out. Never throws. */
export async function dryRunEvalWrappers(draft: unknown, exec: DryRunExec): Promise<ReadonlyMap<string, "passed" | "failed">> {
  const out = new Map<string, "passed" | "failed">();
  try {
    const suites = typeof draft === "object" && draft !== null ? (draft as { suites?: unknown }).suites : undefined;
    if (!Array.isArray(suites)) return out;
    for (const suite of suites.slice(0, MAX_SUITES)) {
      if (typeof suite !== "object" || suite === null) continue;
      const entry = suite as { selection?: unknown; output?: unknown; command?: unknown; report?: unknown };
      const kind = typeof entry.output === "object" && entry.output !== null ? (entry.output as { kind?: unknown }).kind : undefined;
      if (typeof entry.selection !== "string" || (kind !== "rows" && kind !== "custom")) continue;
      out.set(entry.selection, await dryRunEvalWrapper({ output: entry.output, command: entry.command, report: entry.report }, exec));
    }
  } catch { /* what was done stays */ }
  return out;
}
