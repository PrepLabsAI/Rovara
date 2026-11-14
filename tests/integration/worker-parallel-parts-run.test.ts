import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUDGET_EXHAUSTED_FAILURE_MESSAGE, taskGraphDigest, type TaskGraphV1 } from "@agentx/contracts";
import { WorkerCancellationController } from "../../packages/worker/src/cancel.js";
import { runTaskInvocation, type TaskInvocationResult } from "../../packages/worker/src/run-task.js";
import { readCandidateRepositories } from "../../packages/worker/src/verification/candidate.js";

// The worker's whole run of an approved plan whose independent parts build side by side, with a fake model that edits the files of the working copy it was started in.

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const item = (id: string, title: string, dependsOn: string[] = []) => ({ id, title, description: `Do ${title}.`, repository: "app", dependsOn });

let root: string;
let repository: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "rovara-parts-run-")));
  repository = join(root, "repo/app");
  await mkdir(repository, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  await writeFile(join(repository, "README.md"), "base\n");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "base");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

type Entry = { itemId: string; sequence: number; state: string; integratedTreeSha?: string };
type Ev = { type?: string; payload?: { workItemProgress?: Entry } };

interface Scenario {
  graph: TaskGraphV1;
  parallel?: { max: number } | undefined;
  /** What the fake model does for a part: returns an error message to end the turn with, or nothing. */
  act: (title: string, cwd: string, running: { now: number; peak: number }, operationId: string, emit: (event: unknown) => void) => Promise<string | undefined>;
  controller?: WorkerCancellationController;
  resumeProgress?: unknown[];
  sequenceStart?: number;
  /** The repository's path in the manifest; default repo/app. */
  manifestPath?: string;
}

async function run(scenario: Scenario): Promise<{ result?: TaskInvocationResult; error?: Error; events: Ev[]; cwds: string[]; peak: number; operationId: string; artifacts: string[] }> {
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
  const resolvedCommit = git("rev-parse", "HEAD");
  const at = new Date().toISOString();
  await mkdir(join(root, ".agentx"), { recursive: true });
  await writeFile(join(root, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "x", projectRevision: 1,
    repositories: [{ name: "app", path: scenario.manifestPath ?? "repo/app", defaultBranch: "main", resolvedCommit, resolvedAt: at, completedAt: at }],
    completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: at }));
  const operationId = randomUUID();
  const runId = randomUUID();
  const graph = scenario.graph;
  const cwds: string[] = [];
  const running = { now: 0, peak: 0 };
  const events: Ev[] = [];
  const artifacts: string[] = [];
  const adapter = {
    async create({ sessionDirectory, cwd }: { sessionDirectory: string; cwd: string }) {
      cwds.push(cwd);
      const spent = cwds.length * 10;
      const sessionFile = join(sessionDirectory, `fixture-${cwds.length}.jsonl`);
      await writeFile(sessionFile, "");
      let listener: (event: unknown) => void = () => undefined;
      let aborted = false;
      return {
        sessionFile, conversationId: "fixture",
        async prompt(text: string) {
          const title = /Title: (.*)/u.exec(text)?.[1] ?? "main";
          running.now += 1;
          running.peak = Math.max(running.peak, running.now);
          let failure: string | undefined;
          try { failure = await scenario.act(title, cwd, running, operationId, (event) => listener(event)); } finally { running.now -= 1; }
          if (aborted) { listener({ type: "message_end", message: { role: "assistant", stopReason: "aborted" } }); return; }
          listener({ type: "message_end", message: { role: "assistant", stopReason: failure === undefined ? "stop" : "error", ...(failure === undefined ? {} : { errorMessage: failure }), content: [{ type: "text", text: `${title} done` }] } });
        },
        async abort() { aborted = true; },
        getModel: () => ({ provider: "fixture", modelId: "fixture" }),
        getSessionStats: () => ({ sessionFile, sessionId: "fixture", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: spent, output: 1, cacheRead: 0, cacheWrite: 0, total: spent + 1 }, cost: 0 }),
        subscribe(next: (event: unknown) => void) { listener = next; return () => undefined; },
        dispose() { return undefined; },
      };
    },
  };
  const invocation = { protocolVersion: 1, kind: "task", operationId, workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt: "Implement", workflowMode: "IMPLEMENT", workflowBase: [{ repositoryId: "app", baseCommitSha: resolvedCommit }],
      workflowDependencies: { graph, ...(scenario.parallel === undefined ? {} : { parallel: scenario.parallel }), ...(scenario.sequenceStart === undefined ? {} : { sequenceStart: scenario.sequenceStart }),
        ...(scenario.resumeProgress === undefined ? {} : { resumeProgress: scenario.resumeProgress }),
        approval: { artifactDigest: "a".repeat(64), graphDigest: taskGraphDigest(graph), workflowRevision: 2, actorId: "b".repeat(64), runId } } } };
  try {
    const result = await runTaskInvocation(invocation as never, { rootPath: root, model: { provider: "fixture", modelId: "fixture" }, piAdapter: adapter,
      ...(scenario.controller === undefined ? {} : { cancellationController: scenario.controller }), eventSink: async (batch) => { events.push(...(batch as unknown as Ev[])); }, artifactSink: async (artifact) => { artifacts.push(artifact.name); } });
    return { result, events, cwds, peak: running.peak, operationId, artifacts };
  } catch (error) {
    return { error: error as Error, events, cwds, peak: running.peak, operationId, artifacts };
  }
}

const progressOf = (events: Ev[]): Entry[] => events.flatMap((event) => event.payload?.workItemProgress === undefined ? [] : [event.payload.workItemProgress]);
/** Where the fake model writes: the part's working copy, or (with no parts) the repository inside the workspace. */
const workFolder = (cwd: string): string => (cwd.endsWith("/app") ? cwd : join(cwd, "repo/app"));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a v2 task's parts, run by the worker", () => {
  it("builds the independent parts at the same time in working copies of their own, then the dependent one on both", async () => {
    const outcome = await run({
      graph: { schemaVersion: 1, taskId: randomUUID(), version: 1, items: [item(A, "A"), item(B, "B"), item(C, "C", [A, B])] }, parallel: { max: 3 },
      act: async (title, cwd, running) => {
        if (title === "A" || title === "B") {
          await writeFile(join(cwd, `${title}.txt`), `from ${title}\n`);
          // Both parts are in their prompts together before either may end.
          for (let spins = 0; running.now < 2 && spins < 200; spins += 1) await wait(5);
        }
        if (title === "C") await writeFile(join(cwd, "C.txt"), `C saw ${await readFile(join(cwd, "A.txt"), "utf8")}${await readFile(join(cwd, "B.txt"), "utf8")}`);
        return undefined;
      },
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.peak).toBe(2);
    const partFolders = outcome.cwds.filter((cwd) => cwd.includes("/.agentx-parts/"));
    expect(partFolders).toHaveLength(3);
    expect(new Set(partFolders).size).toBe(3);
    expect(partFolders.every((cwd) => cwd.startsWith(join(root, ".agentx-parts", "")) && cwd.endsWith("/app"))).toBe(true);
    const repo = async (file: string) => readFile(join(repository, file), "utf8");
    expect([await repo("A.txt"), await repo("B.txt")]).toEqual(["from A\n", "from B\n"]);
    expect(await repo("C.txt")).toBe("C saw from A\nfrom B\n");
    const progress = progressOf(outcome.events);
    expect(progress.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(progress.filter((entry) => entry.state === "IMPLEMENTED").every((entry) => typeof entry.integratedTreeSha === "string")).toBe(true);
    expect(outcome.result?.workflowDependenciesResult?.status).toBe("SUCCEEDED");
    expect(outcome.result?.workflowDependenciesResult?.items.map((entry) => entry.state)).toEqual(["IMPLEMENTED", "IMPLEMENTED", "IMPLEMENTED"]);
    const lastIntegrated = progress.filter((entry) => entry.state === "IMPLEMENTED").at(-1)!.integratedTreeSha;
    expect(outcome.result?.workflowCandidateRepositories?.[0]?.treeSha).toBe(lastIntegrated);
    expect(await readdir(join(root, ".agentx-parts"))).toEqual([]);
    expect(execFileSync("git", ["-C", repository, "status", "--porcelain"], { encoding: "utf8" })).not.toContain(".agentx");
    // Every part's session is reported as usage, with the main session's: four reports, each with its own session's tokens, so activity counts a parallel build whole.
    const usage = outcome.events.filter((event) => event.type === "usage").map((event) => (event.payload as unknown as { tokens?: { input?: number } }).tokens?.input);
    expect(usage).toHaveLength(4);
    expect(new Set(usage).size).toBe(4);
    expect(outcome.artifacts.filter((name) => name.startsWith("usage-part-"))).toHaveLength(3);
    expect(outcome.artifacts).toContain("usage.json");
  });

  it("clears the folders an earlier run left in the parts folder, links included, without following them", async () => {
    const decoy = await mkdtemp(join(tmpdir(), "rovara-decoy-"));
    try {
      await writeFile(join(decoy, "keep.txt"), "keep\n");
      await mkdir(join(root, ".agentx-parts/old-run/app"), { recursive: true });
      await writeFile(join(root, ".agentx-parts/old-run/app/leftover.txt"), "x\n");
      await symlink(decoy, join(root, ".agentx-parts/link-run"));
      const outcome = await run({
        graph: { schemaVersion: 1, taskId: randomUUID(), version: 1, items: [item(A, "A")] }, parallel: { max: 3 },
        act: async (title, cwd) => { await writeFile(join(cwd, `${title}.txt`), "x\n"); return undefined; },
      });
      expect(outcome.error).toBeUndefined();
      expect(await readdir(join(root, ".agentx-parts"))).toEqual([]);
      expect(await readFile(join(decoy, "keep.txt"), "utf8")).toBe("keep\n");
    } finally {
      await rm(decoy, { recursive: true, force: true });
    }
  });

  it("builds the parts one after another when the project repository is the workspace root", async () => {
    // The parts folder would be inside the repository, so nothing is built in it.
    await rm(join(root, "repo"), { recursive: true, force: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    git("init", "--quiet", "--initial-branch=main");
    await writeFile(join(root, "README.md"), "base\n");
    await writeFile(join(root, ".gitignore"), ".agentx/\nagent-sessions/\n.agentx-parts/\n");
    git("add", "README.md", ".gitignore");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "base");
    repository = root;
    const outcome = await run({
      graph: { schemaVersion: 1, taskId: randomUUID(), version: 1, items: [item(A, "A"), item(B, "B")] }, parallel: { max: 3 }, manifestPath: ".",
      act: async (title, cwd) => { await wait(5); await writeFile(join(cwd, `${title}.txt`), "x\n"); return undefined; },
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.peak).toBe(1);
    expect(outcome.cwds.some((cwd) => cwd.includes("/.agentx-parts/"))).toBe(false);
  });

  it("runs the parts one at a time when the cap is 1", async () => {
    const outcome = await run({
      graph: { schemaVersion: 1, taskId: randomUUID(), version: 1, items: [item(A, "A"), item(B, "B"), item(C, "C")] }, parallel: { max: 1 },
      act: async (title, cwd) => { await wait(10); await writeFile(join(cwd, `${title}.txt`), "x\n"); return undefined; },
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.peak).toBe(1);
  });

  it("without the parallel setting the parts run in the workspace itself, one at a time (version 1 and any older broker)", async () => {
    const outcome = await run({
      graph: { schemaVersion: 1, taskId: randomUUID(), version: 1, items: [item(A, "A"), item(B, "B")] },
      act: async (title, cwd) => { await wait(5); await writeFile(join(workFolder(cwd), `${title}.txt`), "x\n"); return undefined; },
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.peak).toBe(1);
    expect(outcome.cwds.some((cwd) => cwd.includes("/.agentx-parts/"))).toBe(false);
    expect(existsSync(join(root, ".agentx-parts"))).toBe(false);
  });

  it("when the budget runs out in one part the run ends with the budget's own words, the finished part is kept, and nothing is left behind", async () => {
    const outcome = await run({
      graph: { schemaVersion: 1, taskId: randomUUID(), version: 1, items: [item(A, "A"), item(B, "B"), item(C, "C", [A, B])] }, parallel: { max: 3 },
      act: async (title, cwd) => {
        if (title === "A") { await wait(5); return "AI budget exhausted (task)"; }
        await wait(40);
        await writeFile(join(cwd, `${title}.txt`), "x\n");
        return undefined;
      },
    });
    expect(outcome.error?.message).toBe(BUDGET_EXHAUSTED_FAILURE_MESSAGE);
    const progress = progressOf(outcome.events);
    expect(progress.filter((entry) => entry.state === "IMPLEMENTED").map((entry) => entry.itemId)).toEqual([B]);
    expect(progress.some((entry) => entry.itemId === C)).toBe(false);
    // The repository holds the finished part (a resume starts from it), not the part that stopped.
    expect(await readFile(join(repository, "B.txt"), "utf8")).toBe("x\n");
    expect(existsSync(join(repository, "A.txt"))).toBe(false);
    expect(await readdir(join(root, ".agentx-parts"))).toEqual([]);
    const finished = progress.find((entry) => entry.state === "IMPLEMENTED")!;
    expect((await readCandidateRepositories([{ repositoryId: "app", directory: repository }]))[0]!.treeSha).toBe(finished.integratedTreeSha);
  });

  it("a cancel stops the parts that are running, starts no other, and leaves nothing behind", async () => {
    const controller = new WorkerCancellationController();
    const prompted: string[] = [];
    const outcome = await run({
      controller, graph: { schemaVersion: 1, taskId: randomUUID(), version: 1, items: [item(A, "A"), item(B, "B"), item(C, "C", [A, B])] }, parallel: { max: 3 },
      act: async (title, _cwd, _running, operationId) => {
        prompted.push(title);
        if (prompted.length === 2) await controller.cancel(operationId);
        await wait(30);
        return undefined;
      },
    });
    expect(outcome.error?.message).toMatch(/was cancelled/);
    expect(prompted.sort()).toEqual(["A", "B"]);
    expect(await readdir(join(root, ".agentx-parts"))).toEqual([]);
  });

  it("a multi-part run that changes no code answers with each part's commands and words, grouped in the plan's order, though the parts ran at once with the same tool-call ids", async () => {
    const outcome = await run({
      graph: { schemaVersion: 1, taskId: randomUUID(), version: 1, items: [item(A, "A"), item(B, "B"), item(C, "C")] }, parallel: { max: 3 },
      act: async (title, cwd, running, _operationId, emit) => {
        const call = (id: string, command: string, text: string) => {
          emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command } });
          return () => emit({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: { content: [{ type: "text", text }] } });
        };
        // Every part uses the id "t1"; all are in their prompts together before any call ends, and the parts end their calls in the reverse of the plan's order.
        const end = call("t1", `check ${title}`, `output of ${title}`);
        for (let spins = 0; running.now < 3 && spins < 200; spins += 1) await wait(5);
        await wait(title === "A" ? 40 : title === "B" ? 20 : 0);
        end();
        return undefined;
      },
    });
    const findings = (outcome.error as { noChangeFindings?: { commands: unknown[]; conclusion?: string } } | undefined)?.noChangeFindings;
    expect(findings?.commands).toEqual([
      { command: "check A", output: "output of A" }, { command: "check B", output: "output of B" }, { command: "check C", output: "output of C" },
    ]);
    expect(findings?.conclusion).toBe("Part 1:\nA done\n\nPart 2:\nB done\n\nPart 3:\nC done");
  });

  it("an ordered (one at a time) run that changes no code labels each part's words in the same way", async () => {
    const outcome = await run({
      graph: { schemaVersion: 1, taskId: randomUUID(), version: 1, items: [item(A, "A"), item(B, "B", [A])] },
      act: async (title, _cwd, _running, _operationId, emit) => {
        emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: `check ${title}` } });
        emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: `output of ${title}` }] } });
        return undefined;
      },
    });
    const findings = (outcome.error as { noChangeFindings?: { commands: unknown[]; conclusion?: string } } | undefined)?.noChangeFindings;
    expect(findings?.commands).toEqual([{ command: "check A", output: "output of A" }, { command: "check B", output: "output of B" }]);
    expect(findings?.conclusion).toBe("Part 1:\nA done\n\nPart 2:\nB done");
  });
});
