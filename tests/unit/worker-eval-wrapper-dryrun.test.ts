// DEC 254zzz43: the setup run dry-runs the wrapper file in its sandbox before it is offered. Here the "sandbox" is a local shell in a temp folder (the file's own scratch folder is under /tmp and removed at the end), so the
// real template runs against sample rows in each format; a wrong description (the wrong id field, a pass rule that never matches, a dotted CSV column, a broken custom file) is `failed`, which is "not offered".
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { EvalOutputShape } from "@agentx/contracts";
import { dryRunEvalWrapper, dryRunEvalWrappers, reportReadsSamples, sampleResultsOf, type DryRunExec } from "../../packages/worker/src/verification/eval-wrapper-dryrun.js";

const exec: DryRunExec = (command, { timeoutSeconds }) => new Promise((resolve) => {
  const child = spawn("sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutSeconds * 1000);
  child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code, output }); });
  child.on("error", () => { clearTimeout(timer); resolve({ exitCode: 127, output }); });
});
const command = { executable: "python3", args: ["evals/run.py"], cwd: "." };
const report = { cwd: ".", argument: "evals/out/results.jsonl" };
const rows = (over: Record<string, unknown> = {}): EvalOutputShape => ({ kind: "rows", format: "jsonl", language: "python", idField: "case_id", pass: { field: "passed", equals: true }, ...over });

describe("the wrapper's dry-run in the setup sandbox", () => {
  it("passes for every format, language and pass rule the template reads", async () => {
    for (const [output, path] of [
      [rows(), "evals/out/results.jsonl"], [rows({ language: "node" }), "evals/out/results.jsonl"],
      [rows({ format: "json" }), "evals/out/results.json"], [rows({ format: "json", rowsKey: "results", idField: "meta.id", pass: { field: "score.value", atLeast: 0.8 } }), "evals/out/results.json"],
      [rows({ format: "csv", pass: { field: "verdict", equals: "pass" } }), "evals/out/results.csv"], [rows({ pass: { field: "ok", equals: 1 } }), "evals/out/results.jsonl"],
    ] as Array<[EvalOutputShape, string]>) {
      expect(await dryRunEvalWrapper({ output, command, report: { cwd: ".", argument: path } }, exec), JSON.stringify(output)).toBe("passed");
    }
  }, 60_000);

  it("fails when the description does not match what the template can read (a dotted CSV column), or the shape is not one", async () => {
    expect(await dryRunEvalWrapper({ output: rows({ format: "csv", idField: "meta.id" }), command, report: { cwd: ".", argument: "evals/out/r.csv" } }, exec)).toBe("failed");
    expect(await dryRunEvalWrapper({ output: { kind: "junit" }, command, report }, exec)).toBe("failed");
    expect(await dryRunEvalWrapper({ output: "nonsense", command, report }, exec)).toBe("failed");
    expect(await dryRunEvalWrapper({ output: rows(), command: { executable: "bad exe", args: [], cwd: "." }, report }, exec)).toBe("failed");
  }, 30_000);

  it("a missing interpreter or a timeout is failed, never passed", async () => {
    expect(await dryRunEvalWrapper({ output: rows(), command, report }, async () => ({ exitCode: 127, output: "" }))).toBe("failed");
    expect(await dryRunEvalWrapper({ output: rows(), command, report }, async () => { throw new Error("gone"); })).toBe("failed");
    // exit 0 with a report that does not say the two sample rows (a wrapper that passes everything) is failed.
    expect(await dryRunEvalWrapper({ output: rows(), command, report }, async () => ({ exitCode: 0, output: "---REPORT---\n<testsuite><testcase name=\"rovara-dry-run-pass\"/><testcase name=\"rovara-dry-run-fail\"/></testsuite>" }))).toBe("failed");
  });

  it("a custom file is only syntax-checked: a good one passes, a broken one fails", async () => {
    const custom = (source: string, language: "python" | "node" = "python"): EvalOutputShape => ({ kind: "custom", language, summary: "reads scores.csv", source });
    expect(await dryRunEvalWrapper({ output: custom("print('hi')\n"), command, report }, exec)).toBe("passed");
    expect(await dryRunEvalWrapper({ output: custom("def broken(:\n"), command, report }, exec)).toBe("failed");
    expect(await dryRunEvalWrapper({ output: custom("export const a = 1;\n", "node"), command, report }, exec)).toBe("passed");
    expect(await dryRunEvalWrapper({ output: custom("const = ;\n", "node"), command, report }, exec)).toBe("failed");
  }, 30_000);

  it("works per suite of a draft, by selection, and leaves out suites that need no file", async () => {
    const result = await dryRunEvalWrappers({ suites: [
      { selection: "evals/a", output: rows(), command, report },
      { selection: "evals/b", output: rows({ format: "csv", idField: "a.b" }), command, report: { cwd: ".", argument: "x.csv" } },
      { selection: "evals/c", output: { kind: "junit" }, command, report },
      { selection: "evals/d", command, report },
    ] }, exec);
    expect([...result.entries()]).toEqual([["evals/a", "passed"], ["evals/b", "failed"]]);
    expect([...await dryRunEvalWrappers("nope", exec)]).toEqual([]);
  }, 30_000);

  it("the sample is two rows in the format, and the report check wants exactly the pass and the fail", () => {
    expect(sampleResultsOf(rows() as Extract<EvalOutputShape, { kind: "rows" }>).trim().split("\n")).toHaveLength(2);
    expect(reportReadsSamples("<testsuite/>")).toBe(false);
  });
});
