// L4-EVW2 (DEC 254zzz20 D2): the wrapper file Rovara proposes, made by code from a template. These tests RUN the generated files (Python and Node, no network, no model) against a fake eval command and read the report
// they write with the SAME reader the eval sandbox uses (`caseRowsOf`, `measuresFromCaseReports`), so what is proved is the whole path from the customer's rows to the questions Rovara compares.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EVAL_WRAPPER_NODE_PATH, EVAL_WRAPPER_PYTHON_PATH, EVAL_WRAPPER_REPORT_PATH, EvalOutputShapeSchema, evalOutputNeedsWrapper, evalWrapperFor, type EvalOutputShape } from "@agentx/contracts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const rows = (over: Partial<Extract<EvalOutputShape, { kind: "rows" }>> = {}): EvalOutputShape => ({ kind: "rows", format: "jsonl", language: "python", idField: "case_id", pass: { field: "passed", equals: true }, ...over });
const report = { cwd: ".", argument: "evals/out/results.jsonl" };

interface Made { root: string; wrapperPath: string; run(env?: Record<string, string>): { status: number | null; stderr: string; xml: string | undefined } }

/** A repository on disk with the customer's fake eval (`evals/run.py` or `evals/run.mjs`) and the wrapper made for `output`. */
function repository(output: EvalOutputShape, evalSource: string, options: { args?: string[]; reportFile?: string; command?: { executable: string; args: string[]; cwd: string } } = {}): Made {
  const root = mkdtempSync(join(tmpdir(), "evw2-"));
  roots.push(root);
  const language = (output as { language: "python" | "node" }).language;
  const script = language === "python" ? "evals/run.py" : "evals/run.mjs";
  const command = options.command ?? { executable: language === "python" ? "python3" : process.execPath, args: [script, ...(options.args ?? [])], cwd: "." };
  const file = evalWrapperFor({ command, report: { cwd: ".", argument: options.reportFile ?? report.argument }, output })!;
  mkdirSync(join(root, "evals"), { recursive: true });
  writeFileSync(join(root, script), evalSource);
  mkdirSync(join(root, "rovara"), { recursive: true });
  const wrapperPath = join(root, file.path);
  writeFileSync(wrapperPath, file.content);
  return {
    root, wrapperPath,
    run(env = {}) {
      const done = spawnSync(language === "python" ? "python3" : process.execPath, [wrapperPath], { cwd: join(root, "evals"), env: { ...process.env, ...env }, encoding: "utf8", timeout: 30_000 });
      const out = join(root, EVAL_WRAPPER_REPORT_PATH);
      return { status: done.status, stderr: done.stderr, xml: existsSync(out) ? readFileSync(out, "utf8") : undefined };
    },
  };
}

const jsonlEval = (records: unknown[]): string => `import os\nos.makedirs("evals/out", exist_ok=True)\nopen("evals/out/results.jsonl", "w").write(${JSON.stringify(records.map((r) => JSON.stringify(r)).join("\n"))})\n`;

describe("evalWrapperFor: which outputs need a wrapper", () => {
  it("makes nothing for an output Rovara already reads (JUnit, promptfoo, measures) or for a report that says nothing", () => {
    for (const output of [{ kind: "junit" }, { kind: "promptfoo" }, { kind: "measures" }, undefined] as Array<EvalOutputShape | undefined>) {
      expect(evalOutputNeedsWrapper(output)).toBe(false);
      expect(evalWrapperFor({ command: { executable: "pytest", args: [], cwd: "." }, report, output })).toBeUndefined();
    }
  });
  it("puts a wrapper only at one of the two fixed paths, by language", () => {
    const python = evalWrapperFor({ command: { executable: "python3", args: ["run.py"], cwd: "." }, report, output: rows() })!;
    const node = evalWrapperFor({ command: { executable: "node", args: ["run.mjs"], cwd: "." }, report, output: rows({ language: "node" }) })!;
    expect([python.path, node.path]).toEqual([EVAL_WRAPPER_PYTHON_PATH, EVAL_WRAPPER_NODE_PATH]);
  });
  it("the shape schema refuses what the templates cannot carry (a rows key on a CSV, a field with a quote, a script over the size limit)", () => {
    const bad = [
      { kind: "rows", format: "csv", language: "python", idField: "id", pass: { field: "ok", equals: true }, rowsKey: "results" },
      { kind: "rows", format: "jsonl", language: "python", idField: "id'; x", pass: { field: "ok", equals: true } },
      { kind: "rows", format: "jsonl", language: "ruby", idField: "id", pass: { field: "ok", equals: true } },
      { kind: "custom", language: "python", summary: "x", source: "x".repeat(12_001) },
      { kind: "custom", language: "python", summary: "x\ny", source: "print(1)" },
      { kind: "rows", format: "jsonl", language: "python", idField: "id", pass: { field: "ok" } },
      { kind: "custom", language: "node", summary: "reads x\u2028process.exit(1)", source: "export {};" },
      { kind: "custom", language: "python", summary: "x", source: "print('\u202e')" },
    ];
    for (const shape of bad) expect(EvalOutputShapeSchema.safeParse(shape).success, JSON.stringify(shape).slice(0, 60)).toBe(false);
    expect(EvalOutputShapeSchema.safeParse(rows()).success).toBe(true);
  });
});

describe("the Python wrapper, run against a fake eval", () => {
  const records = [{ case_id: "a", passed: true }, { case_id: "b", passed: false }, { case_id: "c", passed: "true" }, { case_id: "d" }];

  it("an eval that exits non-zero because cases failed is a measured result; one that wrote nothing keeps its own exit code", () => {
    const failing = repository(rows(), `${jsonlEval(records)}raise SystemExit(3)\n`).run();
    expect(failing.status).toBe(0);
    expect(failing.xml).toContain("<failure");
    const silent = repository(rows(), "raise SystemExit(5)\n").run();
    expect([silent.status, silent.xml]).toEqual([5, undefined]);
    expect(repository(rows(), "pass\n").run().status).toBe(1);
  });

  it("removes results an earlier run left, so a run that wrote nothing can never look fresh", () => {
    const made = repository(rows(), "raise SystemExit(0)\n");
    mkdirSync(join(made.root, "evals/out"), { recursive: true });
    writeFileSync(join(made.root, "evals/out/results.jsonl"), '{"case_id":"old","passed":true}\n');
    mkdirSync(dirname(join(made.root, EVAL_WRAPPER_REPORT_PATH)), { recursive: true });
    writeFileSync(join(made.root, EVAL_WRAPPER_REPORT_PATH), "<testsuite/>");
    const done = made.run();
    expect(done.status).toBe(1);
    expect(done.xml).toBeUndefined();
  });

  it("says in its first lines what it is, and does not touch the network or a secret", () => {
    const text = readFileSync(repository(rows(), jsonlEval(records)).wrapperPath, "utf8");
    expect(text.split("\n").slice(0, 4).join(" ")).toMatch(/Made by Rovara.*Rovara never merges it/u);
    expect(text).not.toMatch(/\b(urllib|socket|requests|http\.client|getpass|keyring)\b/u);
    expect(text).not.toMatch(/os\.environ\[|environ\.get\((?!"ROVARA_EVAL_IDS")/u);
  });
});

describe("the Node wrapper, run against a fake eval", () => {
  const nodeEval = (records: unknown[], text?: string): string => `import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("evals/out", { recursive: true });\nwriteFileSync("evals/out/results.jsonl", ${JSON.stringify(text ?? records.map((r) => JSON.stringify(r)).join("\n"))});\n`;
  const node = (over: Partial<Extract<EvalOutputShape, { kind: "rows" }>> = {}) => rows({ language: "node", ...over });

  it("keeps the command's exit code when it wrote nothing, and treats hostile text as data", () => {
    expect(repository(node(), "process.exit(7);\n").run().status).toBe(7);
    const evil = repository(node(), nodeEval([{ case_id: "e&<\"'", passed: true }]), { args: ["`${process.exit(9)}`", "'; process.exit(9); '"] });
    expect(spawnSync(process.execPath, ["--check", evil.wrapperPath], { encoding: "utf8" }).status).toBe(0);
    const done = evil.run();
    expect(done.status).toBe(0);
    expect(done.xml).toContain("e&amp;&lt;&quot;'");
  });
});

describe("a wrapper the setup agent wrote itself", () => {
  const custom = (source: string): EvalOutputShape => ({ kind: "custom", language: "python", summary: "reads evals/out/scores.csv", source });
  it("is kept as written under a header that says who wrote it, with a shebang kept first", () => {
    const file = evalWrapperFor({ command: { executable: "python3", args: ["run.py"], cwd: "." }, report, output: custom("#!/usr/bin/env python3\nprint('hi')") })!;
    expect(file.path).toBe(EVAL_WRAPPER_PYTHON_PATH);
    expect(file.content.split("\n")[0]).toBe("#!/usr/bin/env python3");
    expect(file.content).toMatch(/# Written by Rovara's setup agent.*reads evals\/out\/scores\.csv/u);
    expect(file.content).toContain("print('hi')\n");
    const plain = evalWrapperFor({ command: { executable: "node", args: [], cwd: "." }, report, output: { kind: "custom", language: "node", summary: "a\nb", source: "export {};" } })!;
    expect(plain.path).toBe(EVAL_WRAPPER_NODE_PATH);
    expect(plain.content.split("\n")[0]).toMatch(/^\/\/ Written by Rovara's setup agent so Rovara can read the results of your eval: a b$/u);
  });
});
