import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSwebenchCommand, swebenchAgentLimits, swebenchInstanceIdFits } from "@agentx/contracts";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { findRepository } from "../../packages/worker/src/swebench/containers.js";
import { gradeProPrediction, proTestCounts } from "../../packages/worker/src/swebench/grade-pro.js";
import { loadProTask, SWEBENCH_PRO_COMMIT, verifierTimeout } from "../../packages/worker/src/swebench/pro-task.js";
import { ToolLoopGuard } from "../../packages/worker/src/tool-loop-guard.js";

const PRO_ID = "instance_NodeBB__NodeBB-00c70ce7b0541cfc94afe567921d7668cdc8f4ac-vnan";
const PRO_ID_NO_SUFFIX = "instance_navidrome__navidrome-0130c6dc13438b48cf0fdfab08a89e357b5517c9";

describe("SWE-Bench Pro in the command (spec 044 FR-001)", () => {
  it("accepts pro and pro-hard with Pro instance IDs, with or without a -v suffix", () => {
    expect(parseSwebenchCommand(`eval swebench pro-hard ${PRO_ID} model GLM 5.3`)).toEqual({ kind: "run", dataset: "pro-hard", instanceId: PRO_ID, modelSelector: "GLM 5.3" });
    expect(parseSwebenchCommand(`eval swebench pro ${PRO_ID_NO_SUFFIX}`)).toEqual({ kind: "run", dataset: "pro", instanceId: PRO_ID_NO_SUFFIX });
  });

  it("refuses an ID written for the other family", () => {
    const wrongFamily = parseSwebenchCommand("eval swebench pro django__django-11099");
    expect(wrongFamily?.kind === "invalid" ? wrongFamily.message : "").toContain("not a SWE-Bench Pro instance ID");
    const wrongWay = parseSwebenchCommand(`eval swebench verified ${PRO_ID}`);
    expect(wrongWay?.kind === "invalid" ? wrongWay.message : "").toContain("not a SWE-bench instance ID (`<owner>__<repo>-<number>`)");
    expect(swebenchInstanceIdFits("pro", PRO_ID)).toBe(true);
    expect(swebenchInstanceIdFits("verified", PRO_ID)).toBe(false);
  });

  it("gives Pro its 50-minute budget and a 400-call backstop, and leaves SWE-bench's alone (FR-005)", () => {
    expect(swebenchAgentLimits("pro-hard")).toEqual({ timeLimitSeconds: 3_000, toolCallLimit: 400 });
    expect(swebenchAgentLimits("verified")).toEqual({ timeLimitSeconds: 3_600, toolCallLimit: 200 });
  });

  it("stops the tool-loop guard at its configured backstop", () => {
    const guard = new ToolLoopGuard(3);
    const start = (id: number) => guard.observe({ type: "tool_execution_start", toolCallId: `c${id}`, toolName: "bash", args: { command: `echo ${id}` } });
    expect([1, 2, 3].map(start).every((action) => action.kind === "none")).toBe(true);
    expect(start(4)).toMatchObject({ kind: "stop", error: { message: expect.stringContaining("more than 3 tool calls") as unknown } });
  });
});

/** A fake raw.githubusercontent.com serving one task's files and the commit's SHA256SUMS. */
function fakeGitHub(files: Record<string, string>, tamper: Partial<Record<string, string>> = {}) {
  const sum = (body: string) => createHash("sha256").update(body).digest("hex");
  const sums = Object.entries(files).map(([path, body]) => `${sum(body)}  tasks/${PRO_ID}/${path}`).join("\n");
  const requested: string[] = [];
  const fetchImplementation = (async (url: string) => {
    requested.push(url);
    const base = `https://raw.githubusercontent.com/scaleapi/SWE-bench_Pro-os/${SWEBENCH_PRO_COMMIT}/v2/`;
    if (!url.startsWith(base)) return new Response("not found", { status: 404 });
    const path = url.slice(base.length);
    if (path === "SHA256SUMS") return new Response(`${sums}\n0000  tasks/other/instruction.md\n`);
    const file = path.slice(`tasks/${PRO_ID}/`.length);
    const body = tamper[file] ?? files[file];
    return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
  }) as typeof fetch;
  return { fetchImplementation, requested };
}

const TASK_FILES = {
  "instruction.md": "Make the post cache a shared instance.\n",
  "task.toml": "[verifier]\nnetwork_mode = \"public\"\ntimeout_sec = 1800.0\n\n[agent]\ntimeout_sec = 3000.0\n",
  "tests/test.sh": "#!/bin/bash\necho verify\n",
  "tests/config.json": "{\"fail_to_pass\": [\"a\"], \"pass_to_pass\": []}",
  "solution/gold_patch.diff": "the answer",
  "environment/Dockerfile": "FROM x",
};

describe("loading a Pro task (spec 044 FR-002)", () => {
  it("fetches the instruction, config and verifier at the pinned commit, never the solution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentx-pro-task-"));
    const { fetchImplementation, requested } = fakeGitHub(TASK_FILES);
    const task = await loadProTask(PRO_ID, directory, { fetch: fetchImplementation });
    expect(task).toMatchObject({ instruction: "Make the post cache a shared instance.\n", verifierTimeoutSeconds: 1_800, commit: SWEBENCH_PRO_COMMIT });
    expect(await readFile(join(task.testsDirectory, "test.sh"), "utf8")).toContain("echo verify");
    expect(requested.some((url) => url.includes("/solution/") || url.includes("/environment/"))).toBe(false);
  });

  it("refuses a file that does not match Scale's checksum, and an unknown task", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentx-pro-task-"));
    const tampered = fakeGitHub(TASK_FILES, { "tests/test.sh": "#!/bin/bash\nexit 0\n" });
    await expect(loadProTask(PRO_ID, directory, { fetch: tampered.fetchImplementation })).rejects.toThrow("tests/test.sh of instance_NodeBB");
    const empty = fakeGitHub({});
    await expect(loadProTask(PRO_ID, directory, { fetch: empty.fetchImplementation })).rejects.toThrow("is not a SWE-Bench Pro V2 task");
  });

  it("reads the verifier's timeout, defaulting to Pro's 3000 seconds", () => {
    expect(verifierTimeout(TASK_FILES["task.toml"])).toBe(1_800);
    expect(verifierTimeout("[agent]\ntimeout_sec = 10\n")).toBe(3_000);
  });
});

describe("grading a Pro prediction (spec 044 FR-006, FR-007)", () => {
  it("counts the listed tests the verifier reports PASSED, from JSON or Python-literal lists", () => {
    const output = { tests: [{ name: "f1", status: "PASSED" }, { name: "f2", status: "FAILED" }, { name: "p1", status: "PASSED" }] };
    expect(proTestCounts({ fail_to_pass: ["f1", "f2"], pass_to_pass: "['p1', 'p2']" }, output)).toEqual({ failToPass: { passed: 1, total: 2 }, passToPass: { passed: 1, total: 2 } });
    expect(proTestCounts({ fail_to_pass: "[\"f1\"]", pass_to_pass: "[]" }, undefined)).toEqual({ failToPass: { passed: 0, total: 1 }, passToPass: { passed: 0, total: 0 } });
  });

  async function grade(reward: string | undefined, patch: string, timedOut = false) {
    const directory = await mkdtemp(join(tmpdir(), "agentx-pro-grade-"));
    const testsDirectory = join(directory, "task", "tests");
    await mkdir(testsDirectory, { recursive: true });
    await writeFile(join(testsDirectory, "config.json"), JSON.stringify({ fail_to_pass: ["f1"], pass_to_pass: ["p1"] }));
    const calls: string[][] = [];
    const docker: DockerCli = {
      async run(args) {
        calls.push([...args]);
        if (args[0] === "run") {
          const logs = args[args.indexOf("--volume", args.findIndex((a) => a.endsWith(":/tmp/replay.patch:ro"))) + 1]!.split(":")[0]!;
          if (reward !== undefined) await writeFile(join(logs, "reward.txt"), `${reward}\n`);
          await writeFile(join(logs, "output.json"), JSON.stringify({ tests: [{ name: "f1", status: reward === "1" ? "PASSED" : "FAILED" }, { name: "p1", status: "PASSED" }] }));
        }
        return { exitCode: 0, stdout: "", stderr: "", ...(timedOut ? { timedOut: true } : {}) };
      },
    };
    const report = await gradeProPrediction({ directory: join(directory, "grade"), image: "ghcr.io/scaleapi/swe-bench_pro-v2:x", testsDirectory, patch, verifierTimeoutSeconds: 60 }, docker);
    return { report, calls, directory };
  }

  it("runs the task's verifier in a fresh container on the patched repository, as Scale's re-grader applies it", async () => {
    const { report, calls, directory } = await grade("1", "diff --git a/x b/x\n");
    expect(report).toMatchObject({ resolved: true, failToPass: { passed: 1, total: 1 }, passToPass: { passed: 1, total: 1 } });
    const run = calls[0]!;
    expect(run).toEqual(expect.arrayContaining(["--rm", "--platform", "linux/amd64", "ghcr.io/scaleapi/swe-bench_pro-v2:x"]));
    expect(run).not.toContain("--network");
    expect(run).toContain(`${join(directory, "task", "tests")}:/tests:ro`);
    const script = run.at(-1)!;
    expect(script).toContain("cd /app 2>/dev/null || cd /testbed");
    expect(script).toContain("git apply --verbose /tmp/replay.patch || git apply --3way /tmp/replay.patch || patch --fuzz=3 -p1 -i /tmp/replay.patch");
    expect(script).toContain("if [ -s /tmp/replay.patch ]");
    expect(script).toContain("bash /tests/test.sh");
    expect(await readFile(join(directory, "grade", "prediction.patch"), "utf8")).toBe("diff --git a/x b/x\n");
    expect(report.files.map((file) => file.name)).toContain("harness/output.json");
  });

  it("is unresolved for reward 0, a missing reward, or a timeout", async () => {
    expect((await grade("0", "x")).report.resolved).toBe(false);
    expect((await grade(undefined, "x")).report.resolved).toBe(false);
    expect((await grade("1", "x", true)).report.resolved).toBe(false);
  });
});

describe("finding the repository in a Pro image (spec 044 FR-004)", () => {
  const answering = (stdout: string, exitCode = 0): DockerCli => ({ run: async () => ({ exitCode, stdout, stderr: "" }) });
  it("finds /app or /testbed, and refuses an image with neither", async () => {
    await expect(findRepository(answering("/app\n"), "img")).resolves.toBe("/app");
    await expect(findRepository(answering("/testbed\n"), "img")).resolves.toBe("/testbed");
    await expect(findRepository(answering("", 3), "img")).rejects.toThrow("could not find the repository in img");
  });
});

describe("a Pro run end to end (spec 044)", () => {
  it("prompts with instruction.md, keeps the hidden tests outside the agent's mounts, and grades with the verifier", async () => {
    const base = await mkdtemp(join(tmpdir(), "agentx-pro-run-"));
    const source = join(base, "source");
    await mkdir(source);
    const git = (...args: string[]) => import("node:child_process").then(({ execFileSync }) => execFileSync("git", args, { cwd: source }).toString().trim());
    await git("init", "--quiet");
    await git("config", "user.email", "t@example.com");
    await git("config", "user.name", "T");
    await writeFile(join(source, "cache.js"), "module.exports = {};\n");
    await git("add", ".");
    await git("commit", "--quiet", "-m", "base");
    const baseCommit = await git("rev-parse", "HEAD");
    const { runSwebench } = await import("../../packages/worker/src/swebench/run.js");
    const rootPath = join(base, "eval");
    const runId = "3f0c2a4e-8a51-4b8e-9d57-0e5f4f5b1c11";
    const runRoot = join(rootPath, runId);
    const mounts: string[] = [];
    const docker: DockerCli = {
      async run(args) {
        if (args[0] === "image") return { exitCode: 0, stdout: JSON.stringify(["ghcr.io/scaleapi/swe-bench_pro-v2@sha256:abc"]), stderr: "" };
        if (args[0] === "cp") {
          const { cp } = await import("node:fs/promises");
          await cp(source, args[2]!, { recursive: true });
        }
        if (args[0] === "run" && args.includes("--detach")) args.forEach((arg, index) => { if (args[index - 1] === "--volume") mounts.push(arg); });
        if (args[0] === "run" && args.at(-1)?.includes("for d in /app /testbed")) return { exitCode: 0, stdout: "/app\n", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const { fetchImplementation } = fakeGitHub({ ...TASK_FILES, "instruction.md": "Make the post cache a shared instance (Pro instruction).\n" });
    const row = { instance_id: PRO_ID, repo: "NodeBB/NodeBB", base_commit: baseCommit, problem_statement: "short statement", docker_image: "ghcr.io/scaleapi/swe-bench_pro-v2:x" };
    let prompt = "";
    let gradedTests = "";
    const result = await runSwebench({
      runId, dataset: "pro-hard", instanceId: PRO_ID, model: { provider: "amazon-bedrock", modelId: "m" }, maxCostUsd: 10,
      controlPlaneUrl: "https://api.example.com", capability: "c", artifactBucket: "agentx-artifacts", artifactsPrefix: `evals/${runId}/`,
    }, {
      rootPath,
      model: { provider: "amazon-bedrock", modelId: "m" },
      docker,
      reporter: { started: async () => undefined, artifact: async () => undefined, result: async () => undefined },
      log: () => undefined,
      dataset: { fetch: async () => new Response(JSON.stringify({ rows: [{ row }] })) },
      proTask: { fetch: fetchImplementation },
      piAdapter: {
        async create({ sessionDirectory }) {
          const sessionFile = join(sessionDirectory, "s.jsonl");
          await writeFile(sessionFile, "");
          return {
            conversationId: "s", sessionFile,
            async prompt(text) { prompt = text; await writeFile(join(runRoot, "testbed", "cache.js"), "module.exports = { shared: true };\n"); },
            async abort() {}, getModel: () => ({ provider: "amazon-bedrock", modelId: "m" }),
            getSessionStats: () => ({ sessionFile, sessionId: "s", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0.01 }),
            subscribe: () => () => undefined, dispose() {},
          };
        },
      },
      gradePro: async (input) => {
        gradedTests = input.testsDirectory;
        expect(await readFile(join(input.testsDirectory, "test.sh"), "utf8")).toContain("echo verify");
        return { resolved: true, failToPass: { passed: 1, total: 1 }, passToPass: { passed: 0, total: 0 }, files: [] };
      },
    });
    expect(result).toMatchObject({ outcome: "GRADED", resolved: true, failToPass: { passed: 1, total: 1 }, imageDigest: "ghcr.io/scaleapi/swe-bench_pro-v2@sha256:abc" });
    expect(prompt).toContain("Make the post cache a shared instance (Pro instruction).");
    expect(prompt).not.toContain("short statement");
    expect(prompt).toContain("(also /app in the shell)");
    // The agent's container mounts the run's root and the repository at /app; the tests are in neither.
    expect(mounts).toContain(`${join(runRoot, "testbed")}:/app`);
    expect(mounts.every((mount) => !gradedTests.startsWith(mount.split(":")[0]!))).toBe(true);
    expect(gradedTests.startsWith(`${runRoot}/`)).toBe(false);
  });
});
