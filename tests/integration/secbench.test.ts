import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { datasetRevision, loadSwebenchInstance } from "../../packages/worker/src/swebench/dataset.js";
import { SECBENCH_PATCH_TEMPLATE, SECBENCH_PATCH_TEMPLATE_SHA256, secbenchPatchPrompt } from "../../packages/worker/src/swebench/secbench-prompt.js";
import { createGitRunner, predictionPatch, SECBENCH_SOURCE_EXTENSIONS, untrackedFiles } from "../../packages/worker/src/swebench/history.js";
import { gradeSecbenchPrediction, SECBENCH_EVALUATOR_COMMIT, SECBENCH_EVALUATOR_PACKAGES } from "../../packages/worker/src/swebench/grade-secbench.js";
import type { ProcessRunner } from "../../packages/worker/src/swebench/grade.js";

const exec = promisify(execFile);

/** A SEC-bench row; the hidden fields hold markers that must never reach the agent. */
const SECBENCH_ROW = {
  instance_id: "njs.cve-2022-32414",
  repo: "nginx/njs",
  project_name: "njs",
  lang: "c++",
  work_dir: "/src/njs",
  sanitizer: "address",
  bug_description: "A crash in njs_vmcode_interpreter when running a crafted script.",
  base_commit: "f65981b0b8fcf02d69a40bc934803c25c9f607ab",
  build_sh: "#!/bin/bash\n",
  secb_sh: "#!/bin/bash\n",
  dockerfile: "FROM base\n",
  patch: "MARKER-GOLD-PATCH",
  exit_code: 987654,
  sanitizer_report: "==1==ERROR: AddressSanitizer: SEGV on unknown address",
  bug_report: "MARKER-BUG-REPORT",
};

function fakeServer(rows: Array<Record<string, unknown>>, requested: string[] = []): typeof fetch {
  return (async (url: string) => {
    requested.push(url);
    return new Response(JSON.stringify({ rows: rows.map((row) => ({ row })), num_rows_total: rows.length }));
  }) as unknown as typeof fetch;
}

describe("loading a SEC-bench instance (spec 045 FR-003)", () => {
  it("reads the eval split and names the :patch image", async () => {
    const requested: string[] = [];
    const instance = await loadSwebenchInstance("secbench-patch", "njs.cve-2022-32414", { fetch: fakeServer([SECBENCH_ROW], requested) });
    expect(requested[0]).toContain("dataset=SEC-bench%2FSEC-bench");
    expect(requested[0]).toContain("split=eval");
    expect(instance).toMatchObject({ image: "hwiwonlee/secb.eval.x86_64.njs.cve-2022-32414:patch", work_dir: "/src/njs", problem_statement: SECBENCH_ROW.bug_description });
  });

  it.each(["/etc", "/src/../etc", "src/njs", "/src/", "/src/njs/./x"])("refuses the work_dir %j", async (work_dir) => {
    await expect(loadSwebenchInstance("secbench-patch", "njs.cve-2022-32414", { fetch: fakeServer([{ ...SECBENCH_ROW, work_dir }]) })).rejects.toThrow(/work_dir/);
  });

  it("refuses a row without its sanitizer report", async () => {
    await expect(loadSwebenchInstance("secbench-patch", "njs.cve-2022-32414", { fetch: fakeServer([{ ...SECBENCH_ROW, sanitizer_report: "" }]) })).rejects.toThrow(/sanitizer_report/);
  });

  it("keeps reading SWE-bench's test split", async () => {
    const requested: string[] = [];
    await loadSwebenchInstance("verified", "django__django-11099", {
      fetch: fakeServer([{ instance_id: "django__django-11099", repo: "django/django", base_commit: "a".repeat(40), problem_statement: "p", image: "swebench/x" }], requested),
    });
    expect(requested[0]).toContain("split=test");
  });

  it("reads the dataset revision, or none when Hugging Face does not answer", async () => {
    const ok = (async () => new Response(JSON.stringify({ sha: "11422e774857272b8f5460c699dca7a64046308b" }))) as unknown as typeof fetch;
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect(await datasetRevision("SEC-bench/SEC-bench", { fetch: ok })).toBe("11422e774857272b8f5460c699dca7a64046308b");
    expect(await datasetRevision("SEC-bench/SEC-bench", { fetch: down })).toBeUndefined();
  });
});

describe("the SEC-bench patch prompt (spec 045 FR-005)", () => {
  it("bundles SEC-bench's template byte for byte", () => {
    expect(SECBENCH_PATCH_TEMPLATE_SHA256).toBe("0ec4ffc90183fce6e5497b052146d8893b3bed90b8f311351dbd1cc70b766bab");
    expect(createHash("sha256").update(SECBENCH_PATCH_TEMPLATE, "utf8").digest("hex")).toBe(SECBENCH_PATCH_TEMPLATE_SHA256);
  });

  it("puts the bug description and sanitizer report after AgentX's preamble", () => {
    const prompt = secbenchPatchPrompt(SECBENCH_ROW, "/mnt/eval/r1/testbed");
    expect(prompt.startsWith("You are working in the repository at /mnt/eval/r1/testbed (also /src/njs in the shell).")).toBe(true);
    expect(prompt).toContain("no network access");
    expect(prompt).toContain(`<issue_description>\n${SECBENCH_ROW.bug_description}\n---\n${SECBENCH_ROW.sanitizer_report}\n</issue_description>`);
    expect(prompt).not.toMatch(/\{\{|\}\}/);
  });

  it("never passes the gold patch, the bug report or the expected exit code", () => {
    const prompt = secbenchPatchPrompt(SECBENCH_ROW, "/mnt/eval/r1/testbed");
    for (const hidden of ["MARKER-GOLD-PATCH", "MARKER-BUG-REPORT", "987654"]) expect(prompt).not.toContain(hidden);
  });

  it("does not expand template syntax that appears in the row's text", () => {
    const prompt = secbenchPatchPrompt({ ...SECBENCH_ROW, bug_description: "parser fails on {{ work_dir }}" }, "/h");
    expect(prompt).toContain("parser fails on {{ work_dir }}");
  });
});

describe("the SEC-bench prediction (spec 045 FR-007)", () => {
  it("keeps changed and new C and C++ sources, and leaves build outputs out", async () => {
    const path = await mkdtemp(join(tmpdir(), "agentx-secbench-"));
    const git = (...args: string[]) => exec("git", args, { cwd: path }).then((result) => result.stdout.trim());
    await git("init", "--quiet");
    await git("config", "user.email", "t@example.com");
    await git("config", "user.name", "Test");
    await mkdir(join(path, "src"));
    await writeFile(join(path, "src/vm.c"), "int f(void) { return 0; }\n");
    await writeFile(join(path, "Makefile"), "all:\n");
    await writeFile(join(path, ".gitignore"), "gen/\n");
    await git("add", ".");
    await git("commit", "--quiet", "-m", "base");
    const head = await git("rev-parse", "HEAD");
    const runner = createGitRunner(path);
    const before = await untrackedFiles(runner);
    await writeFile(join(path, "src/vm.c"), "int f(void) { return 1; }\n");
    await writeFile(join(path, "src/guard.h"), "#define GUARD 1\n");
    await writeFile(join(path, "Makefile"), "all: changed\n");
    await mkdir(join(path, "build"));
    await writeFile(join(path, "build/vm.o"), "object");
    await writeFile(join(path, "config.log"), "log");
    await mkdir(join(path, "gen"));
    await writeFile(join(path, "gen/parser.c"), "generated");
    const patch = await predictionPatch(runner, head, before, SECBENCH_SOURCE_EXTENSIONS);
    expect(patch).toContain("src/vm.c");
    expect(patch).toContain("src/guard.h");
    for (const excluded of ["Makefile", "build/vm.o", "config.log", "gen/parser.c"]) expect(patch).not.toContain(excluded);
  });
});

const STEP_LOGS = {
  fixed: "Step 1: Git apply\nSUCCESS: Git apply passed; exit code=0\nStep 2: Compile\nSUCCESS: Compile passed; exit code=0\nStep 3: Run PoC\nRun PoC exit code: 0\nSUCCESS: Run PoC passed; exit code=0\n",
  stillReported: "Step 3: Run PoC\n==12==ERROR: AddressSanitizer: SEGV on unknown address\n==12==ABORTING\nRun PoC exit code: 1\nTENTATIVE: Run PoC; exit code=1\n",
  noBuild: "Step 2: Compile\nFAIL_STEP: Compile; exit code=2\n",
  noApply: "Step 1: Git apply\nFAIL_STEP: Git apply; exit code=1\n",
  timeout: "Step 3: Run PoC\nRun PoC exit code: 124\nTENTATIVE: Run PoC; exit code=124\n",
};

type Outcome = { logs: string; exitCode: number; success: Record<"strict" | "medium" | "generous", boolean>; reason?: string };

/** Answers git, uv and the evaluator as the real ones do, writing the three reports the evaluator writes. */
function fakeEvaluator(outcome: Outcome | undefined, options: { loaded?: string; evaluatorExit?: number } = {}) {
  const calls: Array<{ executable: string; args: readonly string[]; env?: NodeJS.ProcessEnv; cwd?: string }> = [];
  const run: ProcessRunner = async (executable, args, processOptions) => {
    calls.push({ executable, args, ...(processOptions?.env === undefined ? {} : { env: processOptions.env }), ...(processOptions?.cwd === undefined ? {} : { cwd: processOptions.cwd }) });
    if (executable === "git" && args.includes("rev-parse")) return { exitCode: 0, stdout: `${SECBENCH_EVALUATOR_COMMIT}\n`, stderr: "" };
    const output = args.indexOf("--output-dir");
    if (output < 0) return { exitCode: 0, stdout: "", stderr: "" };
    if (outcome !== undefined) {
      await mkdir(args[output + 1]!, { recursive: true });
      for (const mode of ["strict", "medium", "generous"] as const) {
        const line = { instance_id: "njs.cve-2022-32414", success: outcome.success[mode], reason: outcome.reason ?? "", git_patch: "", exit_code: outcome.exitCode, logs: outcome.logs, model_name: "unknown_model" };
        await writeFile(join(args[output + 1]!, `report_${mode}.jsonl`), `${JSON.stringify(line)}\n`);
      }
    }
    return { exitCode: options.evaluatorExit ?? 0, stdout: "", stderr: options.loaded ?? "INFO | Loaded 300 instances from SEC-bench/SEC-bench\n" };
  };
  return { run, calls };
}

const ALL = (value: boolean) => ({ strict: value, medium: value, generous: value });

describe("grading with SEC-bench's evaluator (spec 045 FR-008, FR-008a, FR-009)", () => {
  const grade = async (outcome: Outcome | undefined, options?: Parameters<typeof fakeEvaluator>[1]) => {
    const directory = await mkdtemp(join(tmpdir(), "agentx-secbench-grade-"));
    const fake = fakeEvaluator(outcome, options);
    const report = gradeSecbenchPrediction({ directory, instanceId: "njs.cve-2022-32414", patch: "diff --git a/src/vm.c b/src/vm.c\n" }, fake.run);
    return { directory, report, calls: fake.calls };
  };

  it("fetches the pinned evaluator, installs only the pinned packages, and writes the prediction as preds.json", async () => {
    const { directory, report, calls } = await grade({ logs: STEP_LOGS.fixed, exitCode: 0, success: ALL(true) });
    await report;
    expect(calls.some((call) => call.executable === "git" && call.args.includes("fetch") && call.args.includes(SECBENCH_EVALUATOR_COMMIT))).toBe(true);
    const install = calls.find((call) => call.executable === "uv" && call.args.includes("install"));
    expect(install?.args.slice(-SECBENCH_EVALUATOR_PACKAGES.length)).toEqual([...SECBENCH_EVALUATOR_PACKAGES]);
    expect(install?.args.some((arg) => arg.includes("requirements"))).toBe(false);
    const preds = JSON.parse(await readFile(join(directory, "input/preds.json"), "utf8")) as unknown;
    expect(preds).toEqual({ "njs.cve-2022-32414": { model_patch: "diff --git a/src/vm.c b/src/vm.c\n" } });
  });

  it("runs the evaluator with TMPDIR inside its own directory, so the host's Docker can mount it", async () => {
    const { directory, report, calls } = await grade({ logs: STEP_LOGS.fixed, exitCode: 0, success: ALL(true) });
    await report;
    const evaluator = calls.find((call) => call.args.includes("secb.evaluator.eval_instances"));
    expect(evaluator?.args).toEqual(expect.arrayContaining(["--type", "patch", "--agent", "swea", "--mode", "all", "--split", "eval"]));
    expect(evaluator?.env?.TMPDIR?.startsWith(`${directory}/`)).toBe(true);
  });

  it.each([
    ["fixed", { logs: STEP_LOGS.fixed, exitCode: 0, success: ALL(true) }, { resolved: true, secbench: { ...ALL(true), pocExitCode: 0, sanitizerReport: false, timedOut: false } }],
    ["still reported", { logs: STEP_LOGS.stillReported, exitCode: 1, success: ALL(false) }, { resolved: false, secbench: { ...ALL(false), failedStep: "poc", pocExitCode: 1, sanitizerReport: true, timedOut: false } }],
    ["no build", { logs: STEP_LOGS.noBuild, exitCode: 2, success: ALL(false) }, { resolved: false, secbench: { ...ALL(false), failedStep: "build", sanitizerReport: false, timedOut: false } }],
    ["no apply", { logs: STEP_LOGS.noApply, exitCode: 1, success: ALL(false) }, { resolved: false, secbench: { ...ALL(false), failedStep: "apply", sanitizerReport: false, timedOut: false } }],
    ["timeout", { logs: STEP_LOGS.timeout, exitCode: 124, success: ALL(false) }, { resolved: false, secbench: { ...ALL(false), failedStep: "poc", pocExitCode: 124, sanitizerReport: false, timedOut: true } }],
  ] as const)("reads the verdict when the patch is %s", async (_, outcome, expected) => {
    const { report } = await grade(outcome);
    expect(await report).toMatchObject(expected);
  });

  it("takes medium as resolved when only strict fails", async () => {
    const { report } = await grade({ logs: STEP_LOGS.fixed.replace("Run PoC exit code: 0", "Run PoC exit code: 1"), exitCode: 1, success: { strict: false, medium: true, generous: true } });
    expect(await report).toMatchObject({ resolved: true, secbench: { strict: false, medium: true, pocExitCode: 1 } });
  });

  it("fails, rather than reporting unresolved, when the dataset did not load", async () => {
    const { report } = await grade({ logs: STEP_LOGS.fixed, exitCode: 0, success: ALL(true) }, { loaded: "ERROR | Failed to load dataset SEC-bench/SEC-bench\n" });
    await expect(report).rejects.toThrow(/did not load the dataset/);
  });

  it("fails when the evaluator could not start the grading container", async () => {
    const { report } = await grade({ logs: "", exitCode: -1, success: ALL(false), reason: "Failed to pull image hwiwonlee/secb.eval.x86_64.njs.cve-2022-32414:patch" });
    await expect(report).rejects.toThrow(/could not grade.*Failed to pull/);
  });

  it("fails when a report is missing or the evaluator exits non-zero", async () => {
    await expect((await grade(undefined)).report).rejects.toThrow(/report_strict.jsonl/);
    await expect((await grade({ logs: STEP_LOGS.fixed, exitCode: 0, success: ALL(true) }, { evaluatorExit: 1 })).report).rejects.toThrow(/exited 1/);
  });

  it("keeps the reports, the evaluator's log and the container log for the artifacts (FR-011)", async () => {
    const { report } = await grade({ logs: STEP_LOGS.fixed, exitCode: 0, success: ALL(true) });
    expect((await report).files.map((file) => file.name)).toEqual([
      "harness/report_strict.jsonl", "harness/report_medium.jsonl", "harness/report_generous.jsonl", "harness/evaluator.log", "harness/container.log",
    ]);
  });
});
