import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { taskGraphDigest } from "@agentx/contracts";
import { WorkerCancellationController } from "../../packages/worker/src/cancel.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";

describe("worker stops an approved serial graph at acknowledged cancellation", () => {
  it("does not start the next model prompt when cancellation arrives during an item completion acknowledgement", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-spec059-cancel-"));
    try {
      const repository = join(rootPath, "repo/app");
      await mkdir(repository, { recursive: true });
      const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
      git("init", "--quiet", "--initial-branch=main");
      await writeFile(join(repository, "README.md"), "base\n");
      git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "base");
      const resolvedCommit = git("rev-parse", "HEAD");
      const at = new Date().toISOString();
      await mkdir(join(rootPath, ".agentx"));
      await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "x", projectRevision: 1,
        repositories: [{ name: "app", path: "repo/app", defaultBranch: "main", resolvedCommit, resolvedAt: at, completedAt: at }],
        completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: at }));

      const taskId = randomUUID();
      const operationId = randomUUID();
      const runId = randomUUID();
      const graph = { schemaVersion: 1 as const, taskId, version: 1, items: [
        { id: randomUUID(), title: "A", description: "A", repository: "app", dependsOn: [] },
        { id: randomUUID(), title: "B", description: "B", repository: "app", dependsOn: [] },
      ] };
      const controller = new WorkerCancellationController();
      let prompts = 0;
      let listener: (event: unknown) => void = () => undefined;
      const adapter = {
        async create({ sessionDirectory }: { sessionDirectory: string }) {
          const sessionFile = join(sessionDirectory, "fixture.jsonl");
          await writeFile(sessionFile, "");
          return {
            sessionFile, conversationId: "fixture",
            async prompt() {
              prompts += 1;
              await writeFile(join(repository, "README.md"), `item${prompts}\n`);
              listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
            },
            async abort() { return undefined; },
            getModel: () => ({ provider: "fixture", modelId: "fixture" }),
            getSessionStats: () => ({ sessionFile, sessionId: "fixture", userMessages: prompts, assistantMessages: prompts, toolCalls: 0,
              toolResults: 0, totalMessages: prompts * 2, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }),
            subscribe(next: (event: unknown) => void) { listener = next; return () => undefined; },
            dispose() { return undefined; },
          };
        },
      };
      const invocation = { protocolVersion: 1, kind: "task", operationId, workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
        payload: { conversationId: randomUUID(), prompt: "Implement", workflowMode: "IMPLEMENT", workflowBase: [{ repositoryId: "app", baseCommitSha: resolvedCommit }],
          workflowDependencies: { graph, approval: { artifactDigest: "a".repeat(64), graphDigest: taskGraphDigest(graph), workflowRevision: 2, actorId: "b".repeat(64), runId } } } };
      const result = runTaskInvocation(invocation as never, { rootPath, model: { provider: "fixture", modelId: "fixture" }, piAdapter: adapter,
        cancellationController: controller, eventSink: async (batch: unknown[]) => {
          if (batch.some((entry) => {
            if (entry === null || typeof entry !== "object") return false;
            const payload = (entry as { payload?: unknown }).payload;
            if (payload === null || typeof payload !== "object") return false;
            const progress = (payload as { workItemProgress?: { state?: string; itemId?: string } }).workItemProgress;
            return progress?.state === "IMPLEMENTED" && progress.itemId === graph.items[0]!.id;
          })) await controller.cancel(operationId);
        }, artifactSink: async () => undefined });
      await expect(result).rejects.toThrow(/was cancelled/);
      expect(prompts).toBe(1);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
