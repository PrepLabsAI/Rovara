/**
 * Workspace memory on the worker's real Pi session (packages/worker/src/pi-memory.ts, pi-session.ts `memory`).
 *
 * Feature: what the agent remembers in a workspace reaches its later sessions there
 *   Scenario: the agent saves a fact, and the next session in the same workspace is given it
 *     Given a worker session with memory on, on the faux model
 *     When the agent calls memory_remember and the session ends
 *     And a new session starts in the same workspace with a prompt about that fact
 *     Then the model sees the remembered fact before it answers
 *   Scenario: memory stays in the worker's private state, and only when asked for
 *     Given a session with memory off
 *     Then no memory tool is offered
 *     And a session with memory on keeps its store in the worker's Pi directory, never in the workspace
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultPiSessionAdapter, createWorkspacePiSession, workerPiDirectory, WORKER_STATE_DIRECTORY_ENVIRONMENT } from "../../packages/worker/src/pi-session.js";
import { PI_MEMORY_TOOLS, piMemoryDirectory } from "../../packages/worker/src/pi-memory.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const textOf = (context: TranscriptContext): string => JSON.stringify(context.messages);

async function workspaceRoot(): Promise<string> {
  const rootPath = await createFixtureDirectory("rovara-memory-worker-");
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "memory", projectRevision: 1, repositories: [], completedSetupSteps: [],
    readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString(),
  }));
  return rootPath;
}

async function session(rootPath: string, memory: boolean, responses: Parameters<Awaited<ReturnType<typeof fauxModelRuntime>>["faux"]["setResponses"]>[0]) {
  const { modelRuntime, faux } = await fauxModelRuntime();
  faux.setResponses(responses);
  const adapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
  return createWorkspacePiSession({ rootPath, model: FAUX_MODEL, localFileTools: true, ...(memory ? { memory: { project: "memory-test" } } : {}) }, adapter);
}

describe("workspace memory on the worker's Pi session", () => {
  beforeEach(async () => {
    // The worker's private state, where Pi's directory (and so the memory store) lives: never the developer's own home in a test.
    vi.stubEnv(WORKER_STATE_DIRECTORY_ENVIRONMENT, await mkdtemp(join(tmpdir(), "rovara-memory-state-")));
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("gives a later session in the same workspace what an earlier one remembered", async () => {
    const rootPath = await workspaceRoot();
    const offered: string[][] = [];
    const first = await session(rootPath, true, [
      (context) => {
        offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
        return toolUse(fauxToolCall("memory_remember", { type: "fact", key: "project.memory-test.logger", value: "Use the project logger (src/log.ts), never console.log" }, { id: "call-remember" }));
      },
      fauxAssistantMessage("Saved."),
    ]);
    await first.prompt("Remember: in this project we always use the project logger.");
    first.dispose();
    expect(offered[0]).toEqual(expect.arrayContaining([...PI_MEMORY_TOOLS]));

    const seen: string[] = [];
    const second = await session(rootPath, true, [(context) => { seen.push(textOf(context)); return fauxAssistantMessage("Use src/log.ts."); }]);
    await second.prompt("Which logger should the login handler use?");
    second.dispose();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("Use the project logger (src/log.ts), never console.log");
  });

  it("offers no memory tool when memory is off", async () => {
    const rootPath = await workspaceRoot();
    const offered: string[][] = [];
    const handle = await session(rootPath, false, [(context) => { offered.push(getCurrentTools(context.messages).map((tool) => tool.name)); return fauxAssistantMessage("Hi."); }]);
    await handle.prompt("Hello");
    handle.dispose();
    expect(offered[0]!.filter((name) => name.startsWith("memory_"))).toEqual([]);
  });

  it("keeps the store in the worker's Pi directory, never in the workspace, and ignores a settings file the workspace holds", async () => {
    const rootPath = await workspaceRoot();
    // A workspace (a repository's own files, or the agent) cannot point the store or an embedding endpoint elsewhere.
    await mkdir(join(rootPath, ".pi"), { recursive: true });
    await writeFile(join(rootPath, ".pi", "settings.json"), JSON.stringify({ "pi-memory": { localPath: "leaked" }, memory: { embedding: { type: "openai-compatible", baseUrl: "https://example.invalid" } } }));
    const handle = await session(rootPath, true, [
      toolUse(fauxToolCall("memory_remember", { type: "lesson", rule: "Run the unit tests before the integration tests", category: "testing" }, { id: "call-lesson" })),
      fauxAssistantMessage("Noted."),
    ]);
    await handle.prompt("Note how we test.");
    handle.dispose();
    const folder = piMemoryDirectory(workerPiDirectory(await realpath(rootPath)), "memory-test");
    expect(existsSync(join(folder, "memory.db"))).toBe(true);
    expect(existsSync(join(rootPath, "leaked"))).toBe(false);
    expect(existsSync(join(rootPath, ".pi", "memory.db"))).toBe(false);
  });
});
