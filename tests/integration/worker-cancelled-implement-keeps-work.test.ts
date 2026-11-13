// Stop & redirect, R3: what a CANCELLED coding step keeps and what it discards (live-interaction design 3.1, "Open item for R3"). The two sentences the owner reads must both be true: the stopped round's
// edits stay in the workspace (a retry "continues from the current code"), and they were not checked or published (they are "not kept" as a candidate). This pins the first with a real git working copy:
// a file the model wrote before the stop is still there after the stop, uncommitted, the stop did not reset or clean anything, and the restarted step (with the owner's redirect) starts on it. It pins the
// second too: a cancelled round publishes no workspace diff and records no candidate.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REDIRECT_RESTART_NOTE } from "@rovara-code/contracts";
import { WorkerCancellationController, WorkerOperationCancelledError } from "../../packages/worker/src/cancel.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";

const MESSAGE = "msg_0123456789abcdefghij";
const TEXT = "use the retry helper CANCEL-PIN-MARKER";
let root: string;
let repository: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "rovara-cancel-pin-")));
  repository = join(root, "repo/app");
  await mkdir(repository, { recursive: true });
  git("init", "--quiet", "--initial-branch=main");
  await writeFile(join(repository, "README.md"), "base\n");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "base");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function manifest(): Promise<string> {
  const resolvedCommit = git("rev-parse", "HEAD");
  const at = new Date().toISOString();
  await mkdir(join(root, ".agentx"), { recursive: true });
  await writeFile(join(root, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "x", projectRevision: 1,
    repositories: [{ name: "app", path: "repo/app", defaultBranch: "main", resolvedCommit, resolvedAt: at, completedAt: at }], completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: at }));
  return resolvedCommit;
}

/** One coding run over the working copy. `cancelAfterWriting`: the model writes `kept.txt`, then the owner's stop arrives while it works. */
async function run(options: { cancelAfterWriting: boolean; redirect?: boolean; seen?: string[] }) {
  const resolvedCommit = await manifest();
  const operationId = randomUUID();
  const controller = new WorkerCancellationController();
  const prompts: string[] = [];
  const artifacts: string[] = [];
  const adapter = {
    async create({ sessionDirectory }: { sessionDirectory: string }) {
      const sessionFile = join(sessionDirectory, "fixture.jsonl");
      await writeFile(sessionFile, "");
      let listener: (event: unknown) => void = () => undefined;
      return {
        sessionFile, conversationId: "fixture",
        async prompt(text: string) {
          prompts.push(text);
          options.seen?.push(await readFile(join(repository, "kept.txt"), "utf8").catch(() => "(absent)"));
          if (options.cancelAfterWriting) {
            await writeFile(join(repository, "kept.txt"), "half a change\n");
            await controller.cancel(operationId);
            return;
          }
          await writeFile(join(repository, "kept.txt"), "finished change\n");
          listener({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } });
        },
        async abort() { return undefined; },
        getModel: () => ({ provider: "fixture", modelId: "fixture" }),
        getSessionStats: () => ({ sessionFile, sessionId: "fixture", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }),
        subscribe(next: (event: unknown) => void) { listener = next; return () => undefined; },
        dispose() { return undefined; },
      };
    },
  };
  const invocation = { protocolVersion: 1, kind: "task", operationId, workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt: "Implement the approved plan.", workflowMode: "IMPLEMENT", workflowBase: [{ repositoryId: "app", baseCommitSha: resolvedCommit }],
      ...(options.redirect === true ? { ownerRedirect: { messageId: MESSAGE, sender: "person p_a1b2c3", text: TEXT } } : {}) } };
  const events: Array<{ type: string; payload: unknown }> = [];
  try {
    const result = await runTaskInvocation(invocation as never, { rootPath: root, model: { provider: "fixture", modelId: "fixture" }, piAdapter: adapter, cancellationController: controller,
      eventSink: async (batch: Array<{ type: string; payload: unknown }>) => { events.push(...batch); }, artifactSink: async (artifact: { name: string }) => { artifacts.push(artifact.name); }, log: () => undefined } as never);
    return { result, prompts, artifacts, events };
  } catch (error) {
    return { error: error as Error, prompts, artifacts, events };
  }
}

describe("a CANCELLED coding step", () => {
  it("ends cancelled and keeps the working copy as it was when the stop arrived: the half-written file is still there, uncommitted, nothing reset or cleaned", async () => {
    const out = await run({ cancelAfterWriting: true });
    expect(out.error).toBeInstanceOf(WorkerOperationCancelledError);
    expect(await readFile(join(repository, "kept.txt"), "utf8")).toBe("half a change\n");
    // Untracked, not committed and not stashed: the stop changed nothing in git.
    expect(git("status", "--porcelain")).toBe("?? kept.txt");
    expect(git("log", "--oneline")).toMatch(/^[0-9a-f]+ base$/u);
    expect(git("stash", "list")).toBe("");
    expect(out.events.some((event) => event.type === "lifecycle" && (event.payload as { status?: string }).status === "CANCELLED")).toBe(true);
  });

  it("discards the round's checking: it publishes no workspace diff and records no candidate (so the words 'not checked' are true)", async () => {
    const out = await run({ cancelAfterWriting: true });
    expect(out.artifacts).not.toContain("workspace.diff");
    expect(Object.keys(out.error ?? {})).not.toContain("workflowCandidateRepositories");
    expect(JSON.stringify(out.error)).not.toContain("workflowCandidateRepositories");
  });

  it("is continued from the current code by the restarted step: it starts on the kept file, with the redirect framed and told to check the files", async () => {
    await run({ cancelAfterWriting: true });
    const seen: string[] = [];
    const out = await run({ cancelAfterWriting: false, redirect: true, seen });
    expect(out.error).toBeUndefined();
    // The model of the restarted step finds the stopped round's file where it was left.
    expect(seen).toEqual(["half a change\n"]);
    expect(out.prompts).toHaveLength(1);
    expect(out.prompts[0]).toContain(REDIRECT_RESTART_NOTE);
    expect(out.prompts[0]).toContain("CANCEL-PIN-MARKER");
    expect(await readFile(join(repository, "kept.txt"), "utf8")).toBe("finished change\n");
  });
});
