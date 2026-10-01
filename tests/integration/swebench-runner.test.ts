import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { SwebenchRunnerConfig, SwebenchRunResult } from "@agentx/contracts";
import type { PiSessionAdapter, PiSessionHandle } from "../../packages/worker/src/pi-session.js";
import { runSwebenchAgent } from "../../packages/worker/src/swebench/agent.js";
import { startTaskContainer, type DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { offlineSettings } from "../../packages/worker/src/swebench/offline.js";
import { loadSwebenchInstance, type SwebenchInstance } from "../../packages/worker/src/swebench/dataset.js";
import { parseHarnessReport } from "../../packages/worker/src/swebench/grade.js";
import { createGitRunner, predictionPatch, stripHistory, untrackedFiles } from "../../packages/worker/src/swebench/history.js";
import { runSwebench, type RunReporter } from "../../packages/worker/src/swebench/run.js";

const run = promisify(execFile);
const RUN_ID = "3f0c2a4e-8a51-4b8e-9d57-0e5f4f5b1c11";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd })).stdout.trim();
}

/**
 * A SWE-bench-like repository: the task's base commit, the image's "SWE-bench" commit on top, and a
 * later upstream fix on a branch and a tag that HEAD cannot reach, plus a remote.
 */
async function taskRepository(): Promise<{ path: string; base: string; head: string; future: string }> {
  const path = await mkdtemp(join(tmpdir(), "agentx-swebench-repo-"));
  await git(path, "init", "--quiet", "--initial-branch=main");
  await git(path, "config", "user.email", "t@example.com");
  await git(path, "config", "user.name", "Test");
  await writeFile(join(path, "validators.py"), "PATTERN = r'^[\\w.@+-]+$'\n");
  await writeFile(join(path, ".gitignore"), "*.egg-info/\n");
  await git(path, "add", ".");
  await git(path, "commit", "--quiet", "-m", "base");
  const base = await git(path, "rev-parse", "HEAD");
  await git(path, "switch", "--quiet", "-c", "upstream");
  await writeFile(join(path, "validators.py"), "PATTERN = r'^[\\w.@+-]+\\Z'\n");
  await git(path, "commit", "--quiet", "-am", "the upstream fix");
  const future = await git(path, "rev-parse", "HEAD");
  await git(path, "tag", "v-future");
  await git(path, "switch", "--quiet", "main");
  await writeFile(join(path, "setup.cfg"), "[metadata]\n");
  await git(path, "add", ".");
  await git(path, "commit", "--quiet", "-m", "SWE-bench");
  const head = await git(path, "rev-parse", "HEAD");
  await git(path, "remote", "add", "origin", "https://github.com/example/example.git");
  // Left by the image's install: untracked, and not the agent's.
  await writeFile(join(path, "build-output.txt"), "left by the image\n");
  return { path, base, head, future };
}

describe("stripping a task repository's history (spec 043 FR-010)", () => {
  it("keeps HEAD and removes every ref, remote and unreachable commit", async () => {
    const repository = await taskRepository();
    const head = await stripHistory(createGitRunner(repository.path), repository.base);
    expect(head).toBe(repository.head);
    expect(await git(repository.path, "rev-parse", "HEAD")).toBe(repository.head);
    expect(await git(repository.path, "for-each-ref")).toBe("");
    expect(await git(repository.path, "remote")).toBe("");
    await expect(git(repository.path, "cat-file", "-e", repository.future)).rejects.toThrow();
    expect(await git(repository.path, "log", "--all", "--format=%s")).not.toContain("upstream fix");
  });

  it("refuses a HEAD that does not descend from the base commit", async () => {
    const repository = await taskRepository();
    await git(repository.path, "checkout", "--quiet", "--detach", repository.future);
    await expect(stripHistory(createGitRunner(repository.path), repository.head)).rejects.toThrow("does not descend from the task's base commit");
  });

  it("makes a patch of the agent's edits and new files that applies to the image's tree", async () => {
    const repository = await taskRepository();
    const runner = createGitRunner(repository.path);
    const head = await stripHistory(runner, repository.base);
    const before = await untrackedFiles(runner);
    expect([...before]).toEqual(["build-output.txt"]);
    await writeFile(join(repository.path, "validators.py"), "PATTERN = r'^[\\w.@+-]+\\Z'\n");
    await writeFile(join(repository.path, "helpers.py"), "def clean(value):\n    return value\n");
    const patch = await predictionPatch(runner, head, before);
    expect(patch).toContain("\\Z");
    expect(patch).toContain("helpers.py");
    expect(patch).not.toContain("build-output.txt");
    expect(patch).not.toContain("setup.cfg");
    // The harness applies it to a fresh copy of the image's tree.
    const fresh = await mkdtemp(join(tmpdir(), "agentx-swebench-fresh-"));
    await git(fresh, "clone", "--quiet", repository.path, ".");
    await git(fresh, "checkout", "--quiet", head);
    await writeFile(join(fresh, "prediction.diff"), patch);
    await git(fresh, "apply", "--check", "prediction.diff");
  });
});

describe("loading an instance from Hugging Face", () => {
  const row = { instance_id: "django__django-11099", repo: "django/django", base_commit: "d26b2424437dabeeca94d7900b37d2df4410da0c", problem_statement: "trailing newline", image: "swebench/sweb.eval.x86_64.django_1776_django-11099:latest", FAIL_TO_PASS: ["a"], PASS_TO_PASS: ["b"] };
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const noSleep = async () => undefined;

  /** A datasets server holding `total` rows, the instance at `at`, each page answered by `answer`. */
  function pages(total: number, at: number, fail: (offset: number, attempt: number) => boolean = () => false) {
    const requested: string[] = [];
    const attempts = new Map<number, number>();
    const fetchImplementation = (async (url: string) => {
      requested.push(url);
      if (!url.includes("/rows?")) return answer({ error: "only pages here" }, 500);
      const offset = Number(new URL(url).searchParams.get("offset"));
      const attempt = (attempts.get(offset) ?? 0) + 1;
      attempts.set(offset, attempt);
      if (fail(offset, attempt)) return answer({ error: "temporarily unavailable" }, 500);
      const rows = Array.from({ length: Math.max(0, Math.min(100, total - offset)) }, (_, index) => ({
        row: offset + index === at ? row : { ...row, instance_id: `other__other-${offset + index}` },
      }));
      return answer({ rows, num_rows_total: total });
    }) as typeof fetch;
    return { fetchImplementation, requested };
  }

  it("reads the test split's pages, never the slow filter endpoint", async () => {
    const { fetchImplementation, requested } = pages(500, 437);
    await expect(loadSwebenchInstance("verified", "django__django-11099", { fetch: fetchImplementation, sleep: noSleep })).resolves.toMatchObject(row);
    expect(requested.every((url) => url.includes("/rows?"))).toBe(true);
    expect(requested[0]).toContain("dataset=SWE-bench%2FSWE-bench_Verified");
    expect(requested).toHaveLength(5);
  });

  it("stops at the first page that holds the instance", async () => {
    const { fetchImplementation, requested } = pages(500, 12);
    await expect(loadSwebenchInstance("verified", "django__django-11099", { fetch: fetchImplementation, sleep: noSleep })).resolves.toMatchObject({ instance_id: "django__django-11099" });
    expect(requested).toHaveLength(1);
  });

  it("retries a page that fails, and gives up after three tries", async () => {
    const flaky = pages(500, 437, (offset, attempt) => offset === 400 && attempt < 3);
    await expect(loadSwebenchInstance("verified", "django__django-11099", { fetch: flaky.fetchImplementation, sleep: noSleep })).resolves.toMatchObject({ image: row.image });
    const down = pages(500, 437, (offset) => offset === 400);
    await expect(loadSwebenchInstance("verified", "django__django-11099", { fetch: down.fetchImplementation, sleep: noSleep })).rejects.toThrow("could not read SWE-bench/SWE-bench_Verified");
  });

  it("refuses an instance the dataset does not hold, and reads Pro's config", async () => {
    const { fetchImplementation } = pages(500, -1);
    await expect(loadSwebenchInstance("verified", "django__django-99999", { fetch: fetchImplementation, sleep: noSleep })).rejects.toThrow("django__django-99999 is not in SWE-bench/SWE-bench_Verified");
    const pro = pages(51, -1);
    await expect(loadSwebenchInstance("pro-hard", "django__django-99999", { fetch: pro.fetchImplementation, sleep: noSleep })).rejects.toThrow("is not in ScaleAI/SWE-bench_Pro");
    expect(pro.requested[0]).toContain("config=hard");
  });

  it("refuses a row without the image SWE-bench's own datasets carry", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
    const { image: _image, ...withoutImage } = row;
    const fetchImplementation = (async () => answer({ rows: [{ row: withoutImage }] })) as typeof fetch;
    await expect(loadSwebenchInstance("verified", "django__django-11099", { fetch: fetchImplementation, sleep: noSleep })).rejects.toThrow("has no image");
  });
});

describe("reading the harness report", () => {
  it("counts the FAIL_TO_PASS and PASS_TO_PASS tests", () => {
    expect(parseHarnessReport({
      "django__django-11099": {
        patch_is_None: false, patch_exists: true, patch_successfully_applied: true, resolved: true,
        tests_status: {
          FAIL_TO_PASS: { success: ["a", "b"], failure: [] },
          PASS_TO_PASS: { success: ["c"], failure: ["d"] },
        },
      },
    }, "django__django-11099")).toEqual({ resolved: true, failToPass: { passed: 2, total: 2 }, passToPass: { passed: 1, total: 2 } });
  });

  it("reads an unapplied patch as unresolved with no tests run", () => {
    expect(parseHarnessReport({ "x__x-1": { resolved: false, patch_successfully_applied: false } }, "x__x-1"))
      .toEqual({ resolved: false, failToPass: { passed: 0, total: 0 }, passToPass: { passed: 0, total: 0 } });
    expect(() => parseHarnessReport({}, "x__x-1")).toThrow("no entry for x__x-1");
  });
});

interface FakeTurn {
  events?: unknown[];
  cost?: number;
  tokens?: number;
  /** Waits for abort instead of returning. */
  hang?: boolean;
  throws?: string;
  edit?: () => Promise<void>;
}

/** A Pi session that emits a scripted turn's events, then ends the prompt. */
function fakeAdapter(turn: FakeTurn, observed: { aborted: boolean; steered: string[]; prompt?: string }): PiSessionAdapter {
  return {
    async create({ sessionDirectory }) {
      const sessionFile = join(sessionDirectory, "fake.jsonl");
      await writeFile(sessionFile, "{\"type\":\"session\"}\n");
      const listeners = new Set<(event: unknown) => void>();
      let cost = 0;
      let tokens = 0;
      let release: (() => void) | undefined;
      const handle: PiSessionHandle = {
        conversationId: "fake",
        sessionFile,
        async prompt(text) {
          observed.prompt = text;
          await turn.edit?.();
          for (const event of turn.events ?? []) {
            if (event && typeof event === "object" && (event as { type?: unknown }).type === "message_end") {
              cost = turn.cost ?? 0.01;
              tokens = turn.tokens ?? 100;
            }
            for (const listener of listeners) listener(event);
            if (observed.aborted) return;
          }
          if (turn.throws !== undefined) throw new Error(turn.throws);
          if (turn.hang === true && !observed.aborted) await new Promise<void>((resolve) => { release = resolve; });
        },
        async steer(text) { observed.steered.push(text); },
        async abort() { observed.aborted = true; release?.(); },
        getModel: () => ({ provider: "amazon-bedrock", modelId: "fixture-model" }),
        getSessionStats: () => ({
          sessionFile, sessionId: "fake", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
          tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens }, cost,
        }),
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        dispose() {},
      };
      return handle;
    },
  };
}

const assistantEnd = (stopReason = "stop", errorMessage?: string) => ({
  type: "message_end",
  message: { role: "assistant", stopReason, ...(errorMessage === undefined ? {} : { errorMessage }) },
});

const failingCall = (id: number) => [
  { type: "tool_execution_start", toolCallId: `c${id}`, toolName: "bash", args: { command: "pytest" } },
  { type: "tool_execution_end", toolCallId: `c${id}`, toolName: "bash", isError: true, result: { content: [{ type: "text", text: "ImportError" }] } },
];

describe("the agent's limits (spec 043 FR-013)", () => {
  const agent = async (turn: FakeTurn, overrides: { maxCostUsd?: number; timeLimitMs?: number } = {}) => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-swebench-agent-"));
    const observed = { aborted: false, steered: [] as string[] } as { aborted: boolean; steered: string[]; prompt?: string };
    const outcome = await runSwebenchAgent({
      rootPath,
      model: { provider: "amazon-bedrock", modelId: "fixture-model" },
      bashOperations: { exec: async () => ({ exitCode: 0 }) },
      paths: { hostFolder: join(rootPath, "testbed"), containerFolder: "/testbed" },
      problemStatement: "UsernameValidator allows trailing newline",
      maxCostUsd: overrides.maxCostUsd ?? 10,
      timeLimitMs: overrides.timeLimitMs ?? 60_000,
      piAdapter: fakeAdapter(turn, observed),
    });
    outcome.session.dispose();
    return { outcome, observed, rootPath };
  };

  it("finishes with the issue in the prompt and the test rule stated", async () => {
    const { outcome, observed, rootPath } = await agent({ events: [assistantEnd()] });
    expect(outcome.stopReason).toBe("finished");
    expect(outcome.detail).toBeUndefined();
    expect(observed.aborted).toBe(false);
    expect(observed.prompt).toContain("<issue>\nUsernameValidator allows trailing newline\n</issue>");
    expect(observed.prompt).toContain("Do not modify, add or delete tests");
    expect(observed.prompt).toContain(join(rootPath, "testbed"));
  });

  it("stops at the cost ceiling after a model turn", async () => {
    const { outcome, observed } = await agent({ events: [assistantEnd(), assistantEnd()], cost: 12.5 }, { maxCostUsd: 10 });
    expect(outcome).toMatchObject({ stopReason: "cost_ceiling", detail: "the run reached its cost ceiling of 10.00 USD" });
    expect(observed.aborted).toBe(true);
  });

  it("stops when a turn used tokens but has no cost", async () => {
    const { outcome, observed } = await agent({ events: [assistantEnd()], cost: 0, tokens: 500 });
    expect(outcome.stopReason).toBe("cost_unknown");
    expect(outcome.detail).toContain("amazon-bedrock/fixture-model");
    expect(observed.aborted).toBe(true);
  });

  it("stops at the time limit", async () => {
    const { outcome, observed } = await agent({ hang: true }, { timeLimitMs: 20 });
    expect(outcome.stopReason).toBe("time_limit");
    expect(observed.aborted).toBe(true);
  });

  it("warns, then stops, a model repeating the same failing call", async () => {
    const { outcome, observed } = await agent({ events: [1, 2, 3, 4, 5].flatMap(failingCall) });
    expect(outcome.stopReason).toBe("loop_guard");
    expect(observed.steered).toHaveLength(1);
    expect(observed.aborted).toBe(true);
  });

  it("does not call a run a model error when a failed call was retried and the agent went on to finish", async () => {
    const { outcome } = await agent({ events: [assistantEnd("error", "OpenRouter request failed; rate limited; wait before retrying"), assistantEnd()] });
    expect(outcome.stopReason).toBe("finished");
    expect(outcome.detail).toBeUndefined();
  });

  it("reports a failed model call", async () => {
    const { outcome } = await agent({ events: [assistantEnd("error", "throttled by Bedrock")] });
    expect(outcome).toMatchObject({ stopReason: "model_error", detail: "throttled by Bedrock" });
    const thrown = await agent({ throws: "connection reset" });
    expect(thrown.outcome).toMatchObject({ stopReason: "model_error", detail: "connection reset" });
  });
});

/** A Docker CLI that serves `cp` from a fixture repository and records every call. */
function fakeDocker(source: string, digest = "swebench/sweb.eval.x86_64.django_1776_django-11099@sha256:abc"): { docker: DockerCli; calls: string[][] } {
  const calls: string[][] = [];
  const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
  return {
    calls,
    docker: {
      async run(args) {
        calls.push([...args]);
        if (args[0] === "image") return ok(JSON.stringify([digest]));
        if (args[0] === "cp") {
          await cp(source, args[2]!, { recursive: true });
          return ok();
        }
        return ok();
      },
    },
  };
}

function config(): SwebenchRunnerConfig {
  return {
    runId: RUN_ID, dataset: "verified", instanceId: "django__django-11099",
    model: { provider: "amazon-bedrock", modelId: "fixture-model" }, maxCostUsd: 10,
    controlPlaneUrl: "https://api.example.com", capability: "cap", artifactBucket: "agentx-artifacts",
    artifactsPrefix: `evals/${RUN_ID}/`,
  };
}

function recordingReporter(): { reporter: RunReporter; steps: string[]; artifacts: Map<string, string>; results: SwebenchRunResult[] } {
  const steps: string[] = [];
  const artifacts = new Map<string, string>();
  const results: SwebenchRunResult[] = [];
  return {
    steps, artifacts, results,
    reporter: {
      async started() { steps.push("started"); },
      async artifact(name, body) { artifacts.set(name, body.toString()); },
      async result(result) { steps.push("result"); results.push(result); },
    },
  };
}

describe("one SWE-bench run (spec 043 FR-008 to FR-015)", () => {
  async function fixture(turn: (testbed: string) => FakeTurn) {
    const repository = await taskRepository();
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-swebench-root-"));
    const testbed = join(rootPath, RUN_ID, "testbed");
    const instance: SwebenchInstance = {
      instance_id: "django__django-11099", repo: "django/django", base_commit: repository.base,
      problem_statement: "trailing newline", image: "swebench/sweb.eval.x86_64.django_1776_django-11099:latest",
      FAIL_TO_PASS: ["a"], PASS_TO_PASS: ["b"],
    };
    const { docker, calls } = fakeDocker(repository.path);
    const recorded = recordingReporter();
    const graded: string[] = [];
    const observed = { aborted: false, steered: [] as string[] };
    const result = await runSwebench(config(), {
      rootPath,
      model: { provider: "amazon-bedrock", modelId: "fixture-model" },
      docker,
      reporter: recorded.reporter,
      log: () => undefined,
      dataset: { fetch: async () => new Response(JSON.stringify({ rows: [{ row: instance }] })) },
      piAdapter: fakeAdapter(turn(testbed), observed),
      grade: async ({ patch, directory }) => {
        graded.push(patch);
        await writeFile(join(rootPath, "report.json"), "{\"graded\":true}");
        expect(directory).toBe(join(rootPath, RUN_ID, "grade"));
        return { resolved: true, failToPass: { passed: 2, total: 2 }, passToPass: { passed: 5, total: 5 }, files: [{ name: "harness/report.json", path: join(rootPath, "report.json") }] };
      },
    });
    return { result, calls, graded, testbed, ...recorded };
  }

  it("runs the agent in the task container, grades its patch and reports it", async () => {
    const { result, calls, graded, steps, artifacts, results } = await fixture((testbed) => ({
      events: [assistantEnd()],
      edit: () => writeFile(join(testbed, "validators.py"), "PATTERN = r'^[\\w.@+-]+\\Z'\n"),
    }));
    expect(result).toMatchObject({
      outcome: "GRADED", resolved: true, stopReason: "finished",
      failToPass: { passed: 2, total: 2 }, passToPass: { passed: 5, total: 5 },
      imageDigest: "swebench/sweb.eval.x86_64.django_1776_django-11099@sha256:abc",
      artifactsPrefix: `evals/${RUN_ID}/`,
      usage: { provider: "amazon-bedrock", costUsd: 0.01 },
    });
    expect(results).toEqual([result]);
    expect(steps).toEqual(["started", "result"]);
    expect(graded[0]).toContain("\\Z");
    expect([...artifacts.keys()].sort()).toEqual(["harness/report.json", "patch.diff", "result.json", "transcript.jsonl"]);
    expect(JSON.parse(artifacts.get("result.json")!)).toMatchObject({
      resolved: true, offlineSettings: ["astropy-iers-offline"], artifacts: ["harness/report.json", "patch.diff", "transcript.jsonl"],
    });
    const container = `agentx-swebench-${RUN_ID}`;
    const started = calls.find((call) => call[0] === "run")!;
    expect(started).toEqual(expect.arrayContaining(["--network", "none", "--platform", "linux/amd64", "--name", container]));
    expect(started.join(" ")).toContain(":/testbed");
    expect(calls.at(-1)).toEqual(["rm", "--force", container]);
  });

  it("reports an empty patch as unresolved without running the harness", async () => {
    const { result, graded } = await fixture(() => ({ events: [assistantEnd()], cost: 20 }));
    expect(graded).toEqual([]);
    expect(result).toMatchObject({ outcome: "GRADED", resolved: false, stopReason: "cost_ceiling", patchBytes: 0 });
    expect(result.outcome === "GRADED" && result.failToPass).toBe(undefined);
  });

  it("reports a run that could not start as FAILED, and still cleans up", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-swebench-root-"));
    const recorded = recordingReporter();
    const { docker, calls } = fakeDocker(rootPath);
    const result = await runSwebench(config(), {
      rootPath,
      model: { provider: "amazon-bedrock", modelId: "fixture-model" },
      docker,
      reporter: recorded.reporter,
      log: () => undefined,
      dataset: { fetch: async () => new Response(JSON.stringify({ rows: [] })) },
    });
    expect(result).toEqual({ outcome: "FAILED", error: "django__django-11099 is not in SWE-bench/SWE-bench_Verified", artifactsPrefix: `evals/${RUN_ID}/` });
    expect(recorded.steps).toEqual(["result"]);
    expect(calls).toEqual([["rm", "--force", `agentx-swebench-${RUN_ID}`]]);
    expect(await readFile(join(rootPath, RUN_ID, ".agentx", "swebench-shell.sh"), "utf8").catch(() => "absent")).toBe("absent");
  });
});

describe("the offline data settings (spec 043 FR-018)", () => {
  it("puts a pytest plugin on every shell command's path, outside the repository", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-swebench-offline-"));
    await mkdir(join(rootPath, ".agentx"), { recursive: true });
    const { docker, calls } = fakeDocker(rootPath);
    await startTaskContainer(docker, { image: "swebench/x:latest", name: "task", rootPath, testbedHost: join(rootPath, "testbed") });
    const shell = await readFile(join(rootPath, ".agentx", "swebench-shell.sh"), "utf8");
    const plugin = join(rootPath, ".agentx", "python");
    expect(shell).toContain(`export PYTHONPATH="${plugin}\${PYTHONPATH:+:$PYTHONPATH}"`);
    expect(shell).toContain('export PYTEST_ADDOPTS="-p agentx_offline${PYTEST_ADDOPTS:+ $PYTEST_ADDOPTS}"');
    // After conda's activation, which would otherwise be the last word on the environment.
    expect(shell.indexOf("PYTEST_ADDOPTS")).toBeGreaterThan(shell.indexOf("conda activate testbed"));
    const source = await readFile(join(plugin, "agentx_offline.py"), "utf8");
    expect(source).toContain("def pytest_configure(config):");
    expect(source).toContain("iers.conf.auto_download = False");
    expect(source).toContain("iers.conf.auto_max_age = None");
    expect(calls).toHaveLength(1);
  });

  it("does nothing where astropy is not installed", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-swebench-offline-"));
    await offlineSettings(rootPath);
    const plugin = join(rootPath, ".agentx", "python");
    const result = await run("python3", ["-c", "import agentx_offline; agentx_offline.pytest_configure(None); print('ok')"], {
      env: { ...process.env, PYTHONPATH: plugin, PYTHONNOUSERSITE: "1" },
    }).catch((error: unknown) => error as { stdout: string });
    expect(result.stdout.trim()).toBe("ok");
  });
});

