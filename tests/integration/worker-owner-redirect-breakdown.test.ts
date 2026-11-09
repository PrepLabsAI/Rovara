// Live interaction I2 (Opus review): the owner's redirect must reach the model on the work-breakdown coding paths too (serial items and parallel parts), exactly once per item prompt,
// and the re-approval stop must fire from a part. Without this a change that built an item prompt from `payload.prompt` would drop the instruction for every plan with a work breakdown.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REDIRECT_RESTART_NOTE, WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE, taskGraphDigest, type TaskGraphV1 } from "@agentx/contracts";
import { WorkerCancellationController } from "../../packages/worker/src/cancel.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const item = (id: string, title: string, dependsOn: string[] = []) => ({ id, title, description: `Do ${title}.`, repository: "app", dependsOn });
const MESSAGE = "msg_0123456789abcdefghij";
const TEXT = "use the retry helper REDIRECT-BREAKDOWN-MARKER";

let root: string;
let repository: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "rovara-redirect-parts-")));
  repository = join(root, "repo/app");
  await mkdir(repository, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  await writeFile(join(repository, "README.md"), "base\n");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "base");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function run(options: { graph: TaskGraphV1; parallel?: { max: number }; redirect: boolean; finalText?: (title: string) => string }) {
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
  const resolvedCommit = git("rev-parse", "HEAD");
  const at = new Date().toISOString();
  await mkdir(join(root, ".agentx"), { recursive: true });
  await writeFile(join(root, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "x", projectRevision: 1,
    repositories: [{ name: "app", path: "repo/app", defaultBranch: "main", resolvedCommit, resolvedAt: at, completedAt: at }],
    completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: at }));
  const operationId = randomUUID();
  const prompts: string[] = [];
  const controller = new WorkerCancellationController();
  const adapter = {
    async create({ sessionDirectory, cwd }: { sessionDirectory: string; cwd: string }) {
      const sessionFile = join(sessionDirectory, `fixture-${String(prompts.length)}.jsonl`);
      await writeFile(sessionFile, "");
      let listener: (event: unknown) => void = () => undefined;
      return {
        sessionFile, conversationId: "fixture",
        async prompt(text: string) {
          prompts.push(text);
          const title = /Title: (.*)/u.exec(text)?.[1] ?? "main";
          // The fake model edits a file in the working copy it was started in (a part's own copy, or the repository), so the run changes code.
          await writeFile(join(cwd.endsWith("/app") ? cwd : join(cwd, "repo/app"), `${title}.txt`), `from ${title}\n`);
          listener({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: options.finalText?.(title) ?? `${title} done` }] } });
        },
        async abort() { return undefined; },
        getModel: () => ({ provider: "fixture", modelId: "fixture" }),
        getSessionStats: () => ({ sessionFile, sessionId: "fixture", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }),
        subscribe(next: (event: unknown) => void) { listener = next; return () => undefined; },
        dispose() { return undefined; },
      };
    },
  };
  const graph = options.graph;
  const invocation = { protocolVersion: 1, kind: "task", operationId, workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt: "Implement the approved plan.", workflowMode: "IMPLEMENT", workflowBase: [{ repositoryId: "app", baseCommitSha: resolvedCommit }],
      ...(options.redirect ? { ownerRedirect: { messageId: MESSAGE, sender: "person p_a1b2c3", text: TEXT } } : {}),
      workflowDependencies: { graph, ...(options.parallel === undefined ? {} : { parallel: options.parallel }),
        approval: { artifactDigest: "a".repeat(64), graphDigest: taskGraphDigest(graph), workflowRevision: 2, actorId: "b".repeat(64), runId: randomUUID() } } } };
  try {
    const result = await runTaskInvocation(invocation as never, { rootPath: root, model: { provider: "fixture", modelId: "fixture" }, piAdapter: adapter, cancellationController: controller,
      eventSink: async () => undefined, artifactSink: async () => undefined, log: () => undefined });
    return { result, prompts };
  } catch (error) {
    return { error: error as Error, prompts };
  }
}

const framed = (prompt: string) => ({ tags: prompt.match(/<person_message /gu)?.length ?? 0, text: prompt.split("REDIRECT-BREAKDOWN-MARKER").length - 1, note: prompt.includes(REDIRECT_RESTART_NOTE) });

describe("an owner redirect on a work-breakdown coding run", () => {
  it("serial items: every item prompt holds the framed instruction exactly once", async () => {
    const out = await run({ redirect: true, graph: { schemaVersion: 1, taskId: randomUUID(), version: 1, items: [item(A, "A"), item(B, "B", [A])] } });
    expect(out.error).toBeUndefined();
    expect(out.prompts).toHaveLength(2);
    for (const prompt of out.prompts) expect(framed(prompt)).toEqual({ tags: 1, text: 1, note: true });
    expect(out.prompts.map((prompt) => /Title: (.*)/u.exec(prompt)?.[1])).toEqual(["A", "B"]);
  });

  it("parallel parts: every part prompt holds the framed instruction exactly once", async () => {
    const out = await run({ redirect: true, parallel: { max: 2 }, graph: { schemaVersion: 1, taskId: randomUUID(), version: 1, items: [item(A, "A"), item(B, "B"), item(C, "C", [A, B])] } });
    expect(out.error).toBeUndefined();
    expect(out.prompts).toHaveLength(3);
    for (const prompt of out.prompts) expect(framed(prompt)).toEqual({ tags: 1, text: 1, note: true });
  });

  it("without a redirect no item prompt carries one (positive control)", async () => {
    const out = await run({ redirect: false, parallel: { max: 2 }, graph: { schemaVersion: 1, taskId: randomUUID(), version: 1, items: [item(A, "A"), item(B, "B")] } });
    expect(out.error).toBeUndefined();
    for (const prompt of out.prompts) expect(framed(prompt)).toEqual({ tags: 0, text: 0, note: false });
  });

  it("a part that ends with the re-approval marker stops the run for re-approval, naming the message id and not the text; a serial item does the same", async () => {
    const asked = (title: string) => (title === "A" ? "I did not act on it.\nRE-APPROVAL NEEDED: also rewrite billing" : `${title} done`);
    for (const parallel of [{ max: 2 }, undefined]) {
      const out = await run({ redirect: true, ...(parallel === undefined ? {} : { parallel }), finalText: asked, graph: { schemaVersion: 1, taskId: randomUUID(), version: 1, items: [item(A, "A"), item(B, "B")] } });
      expect(out.error?.message, JSON.stringify(parallel)).toContain(WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE);
      expect(out.error?.message).toContain(MESSAGE);
      expect(out.error?.message).not.toContain("billing");
      expect(out.error?.message).not.toContain("REDIRECT-BREAKDOWN-MARKER");
    }
  });
});
