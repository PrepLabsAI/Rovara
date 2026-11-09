// SR-1 (M3): through the worker's real task run, a REVIEW that carries a second reviewer returns the second report under its own result key, keeps its usage in artifacts of their own, and emits only usage events that the
// activity index can read (the strict telemetry shape: an extra field would make them unreadable and they would be dropped).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECOND_REVIEW_RESULT_KEY, SecondReviewResultSchema, TaskUsageTelemetrySchema } from "../../packages/contracts/src/index.js";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";

const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], { encoding: "utf8" }).trim();

async function workspace() {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), "agentx-second-review-run-")));
  const directory = join(rootPath, "repo/payments");
  await mkdir(join(directory, "src"), { recursive: true });
  git(directory, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(directory, "src/a.ts"), "export const a = 1;\n");
  git(directory, "add", ".");
  git(directory, "commit", "--quiet", "-m", "base");
  const base = git(directory, "rev-parse", "HEAD");
  const now = new Date().toISOString();
  await mkdir(join(rootPath, ".agentx"), { recursive: true });
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "payments", projectRevision: 1,
    repositories: [{ name: "payments", path: "repo/payments", defaultBranch: "main", resolvedCommit: base, resolvedAt: now, completedAt: now }],
    completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: now,
  }));
  await writeFile(join(directory, "src/a.ts"), "export const a = 2;\n");
  return { rootPath, base };
}

const reviewer = (id: string): PiSessionAdapter => ({
  async create(input) {
    const sessionFile = join(input.sessionDirectory, `${input.conversationId}.jsonl`);
    await writeFile(sessionFile, "{}");
    let listener: ((event: unknown) => void) | undefined;
    return {
      conversationId: input.conversationId ?? "review", sessionFile,
      async prompt() { listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: '{"findings":[]}' }] } }); },
      async abort() {},
      getModel: () => ({ provider: "test", modelId: id }),
      getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }) as never,
      subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
      dispose() {},
    };
  },
});

describe("a real review run with a second reviewer", () => {
  it("returns the second report under its own key, tags its usage by artifact name only, and every usage event stays readable", async () => {
    const w = await workspace();
    const events: Array<{ type: string; payload: unknown }> = [];
    const artifacts: string[] = [];
    await runTaskInvocation({
      protocolVersion: 1 as const, kind: "task" as const, operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
      payload: { conversationId: randomUUID(), prompt: "Run the independent read-only reviews.", workflowMode: "REVIEW" as const, workflowBase: [{ repositoryId: "payments", baseCommitSha: w.base }],
        workflowSecondReviewer: { candidates: [{ model: { provider: "test", modelId: "second-a" } }] } },
    }, {
      rootPath: w.rootPath, model: { provider: "test", modelId: "first-v1" }, piAdapter: reviewer("first-v1"),
      secondReviewer: { candidates: [{ model: { provider: "test", modelId: "second-a" }, piAdapter: reviewer("second-a") }] },
      eventSink: async (batch) => { for (const event of (Array.isArray(batch) ? batch : [batch]) as Array<{ type: string; payload: unknown }>) events.push(event); },
      artifactSink: async (artifact) => { artifacts.push(artifact.name); },
    });
    const result = events.filter((event) => event.type === "result").at(-1)!.payload as Record<string, unknown>;
    const second = SecondReviewResultSchema.parse(result[SECOND_REVIEW_RESULT_KEY]);
    expect(second).toMatchObject({ tries: 1, report: { role: "CRITIC", provider: "test", version: "second-a", status: "PASS" } });
    expect((result.workflowReviews as Array<{ version: string }>).every((report) => report.version === "first-v1")).toBe(true);
    // The second reviewer's usage is kept in its own artifact, and the first reviews' are not renamed.
    expect(artifacts).toContain("workflow-second-review-1-usage.json");
    expect(artifacts).toContain("workflow-review-critic-usage.json");
    // Every usage event is exactly the telemetry the activity index reads, the second reviewer's included.
    const usage = events.filter((event) => event.type === "usage");
    expect(usage.length).toBeGreaterThanOrEqual(3);
    for (const event of usage) expect(TaskUsageTelemetrySchema.safeParse(event.payload).success, JSON.stringify(event.payload)).toBe(true);
  });

  it("asks nothing of a second reviewer when the invocation names none: the result has no such key (cr off)", async () => {
    const w = await workspace();
    const events: Array<{ type: string; payload: unknown }> = [];
    await runTaskInvocation({
      protocolVersion: 1 as const, kind: "task" as const, operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
      payload: { conversationId: randomUUID(), prompt: "Run the independent read-only reviews.", workflowMode: "REVIEW" as const, workflowBase: [{ repositoryId: "payments", baseCommitSha: w.base }] },
    }, {
      rootPath: w.rootPath, model: { provider: "test", modelId: "first-v1" }, piAdapter: reviewer("first-v1"),
      eventSink: async (batch) => { for (const event of (Array.isArray(batch) ? batch : [batch]) as Array<{ type: string; payload: unknown }>) events.push(event); },
      artifactSink: async () => undefined,
    });
    expect(Object.keys(events.filter((event) => event.type === "result").at(-1)!.payload as object)).not.toContain(SECOND_REVIEW_RESULT_KEY);
  });
});
