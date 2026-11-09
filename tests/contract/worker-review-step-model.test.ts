// Trust fix A2: the worker's review sessions run on the model the broker dispatched for the review step (the invocation's `payload.model`), not on the install's default. The reports record that model,
// which is what the task's message and the pull request's Reviews section name. A broker that sets a different model for the review step is therefore enough: no worker change.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { resolveTaskSessionModel } from "../../packages/worker/src/task-model.js";

describe("the review step's model in an actual worker invocation", () => {
  it("runs both reviewer sessions on the dispatched model and records it in the reports, not on the install's default", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-worker-review-model-"));
    try {
      const directory = join(rootPath, "repo/payments");
      await mkdir(directory, { recursive: true });
      const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
      git("init", "--quiet", "--initial-branch=main");
      await writeFile(join(directory, "app.ts"), "export const value = 1;\n");
      git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "base");
      const baseCommitSha = git("rev-parse", "HEAD");
      await writeFile(join(directory, "app.ts"), "export const value = 2;\n");
      const now = new Date().toISOString();
      await mkdir(join(rootPath, ".agentx"), { recursive: true });
      await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "payments", projectRevision: 1,
        repositories: [{ name: "payments", path: "repo/payments", defaultBranch: "main", resolvedCommit: baseCommitSha, resolvedAt: now, completedAt: now }],
        completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: now }));

      // Like the real adapter, a session reports the model it was created with.
      const created: Array<{ provider: string; modelId: string }> = [];
      const adapter: PiSessionAdapter = {
        async create(input) {
          const sessionFile = join(input.sessionDirectory, `${input.conversationId}.jsonl`);
          await writeFile(sessionFile, "{}");
          created.push({ provider: input.model.provider, modelId: input.model.modelId });
          return {
            conversationId: input.conversationId ?? "fixture", sessionFile,
            async prompt() {}, async abort() {},
            getModel: () => ({ provider: input.model.provider, modelId: input.model.modelId }),
            getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 } as never),
            subscribe() { return () => undefined; }, dispose() {},
          };
        },
      };
      const dispatched = { provider: "anthropic", modelId: "claude-opus-4-6" };
      const payload = { conversationId: randomUUID(), prompt: "Run the independent read-only reviews.", workflowMode: "REVIEW" as const, model: dispatched,
        workflowBase: [{ repositoryId: "payments", baseCommitSha }] };
      // What the worker's entry point does with the invocation's model before the task runs.
      const session = await resolveTaskSessionModel(payload, undefined, { AGENTX_MODEL_PROVIDER: "install", AGENTX_MODEL_ID: "install-default" });
      const result = await runTaskInvocation({
        protocolVersion: 1 as const, kind: "task" as const, operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64), payload,
      }, { rootPath, model: session.model, piAdapter: adapter, eventSink: async () => undefined, artifactSink: async () => undefined });

      expect(created.length).toBeGreaterThanOrEqual(2);
      expect(created.every((model) => model.provider === dispatched.provider && model.modelId === dispatched.modelId), JSON.stringify(created)).toBe(true);
      expect(result.workflowReviews?.map(({ role, provider, version }) => ({ role, provider, version })).sort((a, b) => a.role.localeCompare(b.role))).toEqual([
        { role: "CRITIC", provider: dispatched.provider, version: dispatched.modelId }, { role: "SECURITY", provider: dispatched.provider, version: dispatched.modelId }]);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
