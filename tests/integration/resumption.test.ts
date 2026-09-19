import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorkerInvocation } from "@agentx/contracts";
import { loadReconnectState, saveReconnectState } from "../../packages/cli/src/client-state.js";
import { WorkspaceConversationStore } from "../../packages/worker/src/conversations.js";
import { OperationJournal } from "../../packages/worker/src/journal.js";
import { openRegisteredWorkspacePiSession, type PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { reconcileInterruptedOperations } from "../../packages/worker/src/reconcile.js";
import { verifyWorkspaceResume } from "../../packages/worker/src/resume.js";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("workspace and conversation resumption", () => {
  it("retains tracked edits, untracked files, conversation entries and reconnect state across processes", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-resume-"));
    const repository = join(rootPath, "repo/app");
    await mkdir(repository, { recursive: true });
    await run("git", ["init", "--quiet", repository]);
    await writeFile(join(repository, "tracked.txt"), "initial\n");
    await run("git", ["-C", repository, "add", "tracked.txt"]);
    await run("git", ["-C", repository, "-c", "user.name=AgentX", "-c", "user.email=agentx@example.test", "commit", "--quiet", "-m", "initial"]);
    await writeFile(join(repository, "tracked.txt"), "unfinished edit\n");
    await writeFile(join(repository, "untracked.txt"), "private work\n");
    await mkdir(join(rootPath, ".agentx"), { recursive: true });
    const digest = `registry.example.test/worker@sha256:${"a".repeat(64)}`;
    await writeFile(
      join(rootPath, ".agentx/preparation-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        projectName: "payments",
        projectRevision: 1,
        environmentDigest: digest,
        repositories: [],
        completedSetupSteps: [],
        readinessResults: [],
        creationIdentity: "test",
        complete: true,
        updatedAt: new Date().toISOString(),
      }),
    );

    const firstProcess = new WorkspaceConversationStore(rootPath);
    const first = await firstProcess.createSessionFile();
    await appendFile(first.sessionFile, '{"role":"user","text":"first turn"}\n');
    const stateDirectory = join(rootPath, ".client-state");
    const reconnectState = {
      schemaVersion: 1 as const,
      projectName: "payments",
      workspaceId: randomUUID(),
      conversationId: first.conversationId,
      eventCursor: "cursor-7",
    };
    await saveReconnectState(stateDirectory, reconnectState);

    const replacementProcess = new WorkspaceConversationStore(rootPath);
    const resolved = await replacementProcess.resolve(first.conversationId);
    expect(resolved).toBe(first.sessionFile);
    const reopened = await openRegisteredWorkspacePiSession(
      {
        rootPath,
        model: { provider: "fixture", modelId: "fixture" },
        conversationId: first.conversationId,
        sessionFile: resolved,
      },
      reopenAdapter(),
    );
    await reopened.prompt("feedback turn");
    reopened.dispose();

    await expect(readFile(join(repository, "tracked.txt"), "utf8")).resolves.toBe("unfinished edit\n");
    await expect(readFile(join(repository, "untracked.txt"), "utf8")).resolves.toBe("private work\n");
    await expect(readFile(first.sessionFile, "utf8")).resolves.toContain("feedback turn");
    await expect(loadReconnectState(stateDirectory, "payments")).resolves.toEqual(reconnectState);

    const second = await replacementProcess.createSessionFile();
    expect(second.conversationId).not.toBe(first.conversationId);
    await expect(readFile(join(repository, "tracked.txt"), "utf8")).resolves.toBe("unfinished edit\n");
    await expect(verifyWorkspaceResume({ rootPath, projectName: "payments", projectRevision: 1, environmentDigest: digest })).resolves.toMatchObject({ complete: true });
  });

  it("marks ambiguous running effects interrupted after worker replacement without replay", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-reconcile-"));
    const journal = new OperationJournal(rootPath);
    const invocation: WorkerInvocation = {
      protocolVersion: 1,
      kind: "task",
      operationId: randomUUID(),
      workspaceId: randomUUID(),
      fence: 3,
      projectRevision: 1,
      callbackCapability: "c".repeat(64),
      payload: { conversationId: randomUUID(), prompt: "ambiguous command" },
    };
    await journal.accept(invocation);
    await journal.transition(invocation.operationId, "RUNNING");
    await writeFile(join(rootPath, "side-effect.txt"), "may have completed\n");

    const replacementJournal = new OperationJournal(rootPath);
    const interrupted = await reconcileInterruptedOperations(replacementJournal);
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]?.status).toBe("INTERRUPTED");
    expect(interrupted[0]?.error).toContain("not replayed");
    await expect(readFile(join(rootPath, "side-effect.txt"), "utf8")).resolves.toBe("may have completed\n");
  });
});

function reopenAdapter(): PiSessionAdapter {
  return {
    async create() {
      throw new Error("new session was not expected");
    },
    async open(input) {
      return {
        conversationId: input.conversationId,
        sessionFile: input.sessionFile,
        async prompt(text) {
          await appendFile(input.sessionFile, `${JSON.stringify({ role: "user", text })}\n`);
        },
        async abort() {},
        subscribe() {
          return () => undefined;
        },
        dispose() {},
      };
    },
  };
}
