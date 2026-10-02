// Spec 051 Task 7 (FR-010, FR-011): the eval runner records AgentX's checks, the agent's claim and whether they
// disagree. The agent runs on Pi's real session and the faux model, so the real extension and agent_before_settle
// hook run; the checks' runners are fakes except where a test pins the container path. Offline.
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { agentxPreambleSha256, SwebenchRunResultSchema, type SwebenchRunnerConfig, type SwebenchRunResult } from "../../packages/contracts/src/index.js";
import { createDefaultPiSessionAdapter, type PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import type { SwebenchInstance } from "../../packages/worker/src/swebench/dataset.js";
import { runSwebench, type RunReporter } from "../../packages/worker/src/swebench/run.js";
import type { CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const exec = promisify(execFile);
const RUN_ID = "3f0c2a4e-8a51-4b8e-9d57-0e5f4f5b1c11";
const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

async function repository(files: Record<string, string>): Promise<{ path: string; base: string }> {
  const path = await mkdtemp(join(tmpdir(), "agentx-eval-verification-repo-"));
  cleanup.push(path);
  const git = (...args: string[]) => exec("git", args, { cwd: path }).then((result) => result.stdout.trim());
  await git("init", "--quiet", "--initial-branch=main");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "Test");
  for (const [name, body] of Object.entries(files)) await writeFile(join(path, name), body);
  await git("add", ".");
  await git("commit", "--quiet", "-m", "base");
  return { path, base: await git("rev-parse", "HEAD") };
}

/** A Docker CLI that serves `cp` from the fixture repository and records every call, in order. */
function fakeDocker(source: string): { docker: DockerCli; calls: string[][] } {
  const calls: string[][] = [];
  const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
  return {
    calls,
    docker: {
      async run(args) {
        calls.push([...args]);
        if (args[0] === "image") return ok(JSON.stringify([`swebench/x@sha256:${"a".repeat(64)}`]));
        if (args[0] === "cp") await cp(source, args[2]!, { recursive: true });
        return ok();
      },
    },
  };
}

function recordingReporter() {
  const artifacts = new Map<string, string>();
  const results: SwebenchRunResult[] = [];
  const reporter: RunReporter = {
    async started() {},
    async artifact(name, body) { artifacts.set(name, body.toString()); },
    async result(result) { results.push(result); },
  };
  return { reporter, artifacts, results };
}

function fakeRunners(exitCode: number): { runners: CheckRunners; replays: string[] } {
  const replays: string[] = [];
  return {
    replays,
    runners: {
      async runAgentCommand(replay) { replays.push(replay); return { exitCode, timedOut: false, output: exitCode === 0 ? "passed\n" : "1 failed\n" }; },
      async runProjectCommand() { throw new Error("evals have no project checks"); },
    },
  };
}

/** The agent's own shell: every command exits 0 and prints "ok". */
const agentShell: BashOperations = { exec: async (_command, _cwd, options) => { options.onData(Buffer.from("ok\n")); return { exitCode: 0 }; } };

function agentAdapter(steps: FauxResponseStep[]): PiSessionAdapter {
  const ready = fauxModelRuntime().then(({ modelRuntime, faux }) => {
    faux.setResponses(steps);
    return createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
  });
  // The faux provider reports no cost, which the eval's cost guard refuses, so the session reports a small one.
  return {
    create: async (input) => {
      const handle = await (await ready).create({ ...input, bashOperations: agentShell });
      return { ...handle, getSessionStats: () => ({ ...handle.getSessionStats(), cost: 0.01 }) };
    },
  };
}

/** The agent runs the tests, edits a file, runs them again and says how it went. */
function agentSteps(testbed: string, finalText: string, commands: string[] = ["pytest tests/"]): FauxResponseStep[] {
  return [
    ...commands.map((command, index) => toolUse(fauxToolCall("bash", { command }, { id: `before${index}` }))),
    toolUse(fauxToolCall("write", { path: join(testbed, "validators.py"), content: "PATTERN = 1\n" }, { id: "w1" })),
    ...commands.map((command, index) => toolUse(fauxToolCall("bash", { command }, { id: `after${index}` }))),
    fauxAssistantMessage(finalText),
    // The extra turn a regression earns.
    fauxAssistantMessage(finalText),
  ];
}

const swebenchConfig = (): SwebenchRunnerConfig => ({
  runId: RUN_ID, dataset: "verified", instanceId: "django__django-11099",
  model: { provider: "amazon-bedrock", modelId: "fixture-model" }, maxCostUsd: 10,
  controlPlaneUrl: "https://api.example.com", capability: "cap", artifactBucket: "agentx-artifacts",
  artifactsPrefix: `evals/${RUN_ID}/`,
});

async function swebenchRun(options: { finalText: string; passToPass: { passed: number; total: number }; replayExit?: number; useContainerRunners?: boolean }) {
  const repo = await repository({ "validators.py": "PATTERN = 0\n" });
  const rootPath = await mkdtemp(join(tmpdir(), "agentx-eval-verification-root-"));
  cleanup.push(rootPath);
  const testbed = join(rootPath, RUN_ID, "testbed");
  const instance: SwebenchInstance = {
    instance_id: "django__django-11099", repo: "django/django", base_commit: repo.base,
    problem_statement: "trailing newline", image: "swebench/sweb.eval.x86_64.django_1776_django-11099:latest",
    FAIL_TO_PASS: ["a"], PASS_TO_PASS: ["b"],
  };
  const { docker, calls } = fakeDocker(repo.path);
  const recorded = recordingReporter();
  const replays = fakeRunners(options.replayExit ?? 0);
  const result = await runSwebench(swebenchConfig(), {
    rootPath, model: { provider: "amazon-bedrock", modelId: "fixture-model" }, docker, reporter: recorded.reporter, log: () => undefined,
    dataset: { fetch: async () => new Response(JSON.stringify({ rows: [{ row: instance }] })) },
    piAdapter: agentAdapter(agentSteps(testbed, options.finalText)),
    ...(options.useContainerRunners === true ? {} : { checkRunners: replays.runners }),
    grade: async () => ({ resolved: true, failToPass: { passed: 1, total: 1 }, passToPass: options.passToPass, files: [] }),
  });
  return { result, calls, replays: replays.replays, ...recorded };
}

describe("the eval runner records AgentX's checks and the agent's claim (spec 051 FR-010, FR-011)", () => {
  it("writes the checks, the claim, the disagreement and the preamble hash into result.json and the callback", async () => {
    const { result, artifacts, results, replays } = await swebenchRun({ finalText: "Fixed it.\nAgentX result: done", passToPass: { passed: 5, total: 5 } });
    const saved = JSON.parse(artifacts.get("result.json")!) as Record<string, unknown>;
    expect(replays).toEqual(["pytest tests/"]);
    expect(saved).toMatchObject({
      agentClaim: "success",
      preambleSha256: agentxPreambleSha256(),
      checks: { status: "verified", source: "agent_commands", agentClaim: "success", checks: [{ id: "agent:0", before: "passed", after: "passed", class: "passing" }] },
      disagreement: { claimedSuccess: true, checkRegression: false, graderBrokenPassToPass: false, disagrees: false },
    });
    // The callback carries the same fields, and the contract accepts them.
    expect(results).toEqual([result]);
    expect(SwebenchRunResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ outcome: "GRADED", agentClaim: "success", disagreement: { disagrees: false } });
  });

  it("flags a claim of success that the grader's PASS_TO_PASS contradicts", async () => {
    const { result, artifacts } = await swebenchRun({ finalText: "AgentX result: done", passToPass: { passed: 9, total: 10 } });
    expect(JSON.parse(artifacts.get("result.json")!)).toMatchObject({
      checks: { status: "verified" },
      disagreement: { claimedSuccess: true, checkRegression: false, graderBrokenPassToPass: true, disagrees: true },
    });
    expect(result).toMatchObject({ disagreement: { disagrees: true } });
  });

  it("flags a claim of success that AgentX's own rerun contradicts, and does not flag a claim of failure", async () => {
    const regression = await swebenchRun({ finalText: "AgentX result: done", passToPass: { passed: 5, total: 5 }, replayExit: 1 });
    expect(JSON.parse(regression.artifacts.get("result.json")!)).toMatchObject({
      checks: { status: "regression", extraTry: "given" },
      disagreement: { claimedSuccess: true, checkRegression: true, graderBrokenPassToPass: false, disagrees: true },
    });
    const honest = await swebenchRun({ finalText: "AgentX result: not done", passToPass: { passed: 9, total: 10 }, replayExit: 1 });
    expect(JSON.parse(honest.artifacts.get("result.json")!)).toMatchObject({
      agentClaim: "failure", disagreement: { claimedSuccess: false, disagrees: false },
    });
  });

  it("keeps the callback's checks within the compact limit while result.json keeps the full output", async () => {
    const big = "x".repeat(60_000);
    const repo = await repository({ "validators.py": "PATTERN = 0\n" });
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-eval-verification-root-"));
    cleanup.push(rootPath);
    const testbed = join(rootPath, RUN_ID, "testbed");
    const instance: SwebenchInstance = {
      instance_id: "django__django-11099", repo: "django/django", base_commit: repo.base, problem_statement: "p",
      image: "swebench/sweb.eval.x86_64.django_1776_django-11099:latest", FAIL_TO_PASS: ["a"], PASS_TO_PASS: ["b"],
    };
    const recorded = recordingReporter();
    const runners: CheckRunners = {
      async runAgentCommand() { return { exitCode: 0, timedOut: false, output: big }; },
      async runProjectCommand() { throw new Error("none"); },
    };
    const result = await runSwebench(swebenchConfig(), {
      rootPath, model: { provider: "amazon-bedrock", modelId: "fixture-model" }, docker: fakeDocker(repo.path).docker, reporter: recorded.reporter, log: () => undefined,
      dataset: { fetch: async () => new Response(JSON.stringify({ rows: [{ row: instance }] })) },
      piAdapter: agentAdapter(agentSteps(testbed, "AgentX result: done", ["pytest tests/a", "pytest tests/b", "pytest tests/c"])), checkRunners: runners,
      grade: async () => ({ resolved: true, failToPass: { passed: 1, total: 1 }, passToPass: { passed: 1, total: 1 }, files: [] }),
    });
    const total = (checks: Array<{ output: string }>) => checks.reduce((sum, entry) => sum + entry.output.length, 0);
    const saved = JSON.parse(recorded.artifacts.get("result.json")!) as { checks: { checks: Array<{ output: string }> } };
    expect(saved.checks.checks).toHaveLength(3);
    expect(total(saved.checks.checks)).toBe(3 * big.length);
    const callback = result.outcome === "GRADED" ? result.checks!.checks : [];
    expect(callback).toHaveLength(3);
    expect(total(callback)).toBeLessThanOrEqual(65_536);
  });

  it("reruns the checks before the task container is removed", async () => {
    // The default runners: the replay goes through the container's shell, so it shows in the docker calls.
    const { calls, result } = await swebenchRun({ finalText: "AgentX result: done", passToPass: { passed: 1, total: 1 }, useContainerRunners: true });
    expect(result.outcome).toBe("GRADED");
    const container = `agentx-swebench-${RUN_ID}`;
    const execs = calls.flatMap((args, index) => (args[0] === "exec" && args.includes(container) ? [index] : []));
    const removals = calls.flatMap((args, index) => (args[0] === "rm" && args.includes(container) ? [index] : []));
    expect(execs.length).toBeGreaterThan(0);
    expect(removals.length).toBeGreaterThan(0);
    expect(Math.max(...execs)).toBeLessThan(Math.min(...removals));
    // And the replay itself ran in the container: its command text is in an exec call.
    expect(calls.some((args) => args[0] === "exec" && args.join(" ").includes("pytest tests/"))).toBe(true);
  });
});

describe("a SEC-bench run's disagreement (spec 051 FR-011)", () => {
  it("has no grader signal, so graderBrokenPassToPass is null and only AgentX's checks can disagree", async () => {
    const repo = await repository({ "vm.c": "int f(void) { return 0; }\n" });
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-eval-verification-secbench-"));
    cleanup.push(rootPath);
    const testbed = join(rootPath, RUN_ID, "testbed");
    const row = {
      instance_id: "njs.cve-2022-32414", repo: "nginx/njs", project_name: "njs", lang: "c++", work_dir: "/src/njs", sanitizer: "address",
      bug_description: "A crash.", base_commit: repo.base, build_sh: "#!/bin/bash\n", secb_sh: "#!/bin/bash\n", dockerfile: "FROM base\n",
      patch: "x", exit_code: 1, sanitizer_report: "==1==ERROR: AddressSanitizer", bug_report: "x",
    };
    const fetchImplementation = (async (url: string) => url.includes("/api/datasets/")
      ? new Response(JSON.stringify({ sha: "11422e774857272b8f5460c699dca7a64046308b" }))
      : new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 1 }))) as unknown as typeof fetch;
    const recorded = recordingReporter();
    const replays = fakeRunners(1);
    const steps = [
      toolUse(fauxToolCall("bash", { command: "pytest tests/" }, { id: "t1" })),
      toolUse(fauxToolCall("write", { path: join(testbed, "vm.c"), content: "int f(void) { return 1; }\n" }, { id: "w1" })),
      toolUse(fauxToolCall("bash", { command: "pytest tests/" }, { id: "t2" })),
      fauxAssistantMessage("AgentX result: done"),
      fauxAssistantMessage("AgentX result: done"),
    ];
    const result = await runSwebench({ ...swebenchConfig(), dataset: "secbench-patch", instanceId: "njs.cve-2022-32414" }, {
      rootPath, model: { provider: "amazon-bedrock", modelId: "fixture-model" }, docker: fakeDocker(repo.path).docker, reporter: recorded.reporter, log: () => undefined,
      dataset: { fetch: fetchImplementation }, piAdapter: agentAdapter(steps), checkRunners: replays.runners,
      gradeSecbench: async () => ({ resolved: true, secbench: { strict: true, medium: true, generous: true, pocExitCode: 0, sanitizerReport: false, timedOut: false }, files: [] }),
    });
    expect(result).toMatchObject({ disagreement: { claimedSuccess: true, checkRegression: true, graderBrokenPassToPass: null, disagrees: true } });
    const saved = JSON.parse(recorded.artifacts.get("result.json")!) as { secbenchSetup: Record<string, unknown> };
    expect(saved.secbenchSetup).toMatchObject({ promptTemplateSha256: expect.any(String) as unknown, preambleSha256: agentxPreambleSha256() });
  });
});
