// Workspace memory (packages/worker/src/pi-memory.ts): the wrapper around the published pi-memory extension decides where it keeps its store and settings,
// and keeps it from starting a process.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PI_MEMORY_SETTINGS, PI_MEMORY_TOOLS, memoryExtensionApi, piMemoryDirectory, piMemorySessionParts, preparePiMemoryDirectory, taskStageMemory } from "../../packages/worker/src/pi-memory.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakeApi() {
  const handlers = new Map<string, Handler>();
  const exec = vi.fn(async () => ({ code: 0, stdout: "ran", stderr: "", killed: false }));
  const registerTool = vi.fn();
  const api = { on: (event: string, handler: Handler) => { handlers.set(event, handler); }, exec, registerTool } as unknown as ExtensionAPI;
  return { api, handlers, exec, registerTool };
}

describe("the memory extension's API", () => {
  it("starts no process: exec answers as a failed run and never reaches Pi's exec", async () => {
    const { api, exec } = fakeApi();
    const wrapped = memoryExtensionApi(api, "/state/pi/abc/memory");
    await expect(wrapped.exec("pi", ["-p", "consolidate"], {})).resolves.toEqual({ code: 1, stdout: "", stderr: "", killed: false });
    expect(exec).not.toHaveBeenCalled();
  });

  it("gives every event handler the memory folder as its working directory, and the rest of the context unchanged", async () => {
    const { api, handlers } = fakeApi();
    const wrapped = memoryExtensionApi(api, "/state/pi/abc/memory");
    const seen: unknown[] = [];
    wrapped.on("session_start", (_event, ctx) => { seen.push(ctx); });
    const ctx = { cwd: "/workspace/repo/web", hasUI: false, sessionId: "s-1" };
    await handlers.get("session_start")!({ type: "session_start" }, ctx);
    expect(seen).toHaveLength(1);
    const given = seen[0] as typeof ctx;
    expect(given.cwd).toBe("/state/pi/abc/memory");
    expect(given.sessionId).toBe("s-1");
    expect(given.hasUI).toBe(false);
    // The real context is never changed.
    expect(ctx.cwd).toBe("/workspace/repo/web");
  });

  it("passes everything else through", () => {
    const { api, registerTool } = fakeApi();
    const tool = { name: "memory_search" };
    memoryExtensionApi(api, "/m").registerTool(tool as never);
    expect(registerTool).toHaveBeenCalledWith(tool);
  });
});

describe("the memory folder", () => {
  it("is in the worker's private Pi directory and holds Rovara's own settings, rewritten before every session", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "rovara-pi-memory-"));
    const folder = await preparePiMemoryDirectory(agentDirectory, "web");
    expect(folder).toBe(piMemoryDirectory(agentDirectory, "web"));
    expect(folder).toBe(join(agentDirectory, "memory", "web"));
    const settingsPath = join(folder, ".pi", "settings.json");
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(PI_MEMORY_SETTINGS);
    // A settings file changed since (an embedding endpoint, another store) does not survive into the next session.
    await writeFile(settingsPath, JSON.stringify({ memory: { embedding: { type: "openai-compatible", baseUrl: "https://example.invalid" } }, "pi-memory": { localPath: "/elsewhere" } }));
    await preparePiMemoryDirectory(agentDirectory, "web");
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(PI_MEMORY_SETTINGS);
  });

  it("names the folder after the project, so the extension's project facts (project.<name>.*) are this project's", () => {
    expect(piMemoryDirectory("/state/pi/abc", "Web App")).toBe("/state/pi/abc/memory/web-app");
    expect(piMemoryDirectory("/state/pi/abc", "../..")).toBe("/state/pi/abc/memory/project");
  });

  it("sets no embedding, so the extension makes no network call", () => {
    expect(JSON.stringify(PI_MEMORY_SETTINGS)).not.toContain("embedding");
    expect(PI_MEMORY_SETTINGS["pi-memory"].localPath).toBe(".");
  });
});

describe("which sessions have memory", () => {
  it("every task stage but a review, for the task's project", () => {
    expect(taskStageMemory({ reviewing: false, project: "web" })).toEqual({ memory: { project: "web" } });
    expect(taskStageMemory({ reviewing: true, project: "web" })).toEqual({});
  });

  it("a session without memory gets no extension and no tool, and makes no folder", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "rovara-pi-memory-"));
    expect(await piMemorySessionParts(agentDirectory, undefined)).toEqual({ extensions: [], tools: [] });
    await expect(readFile(join(agentDirectory, "memory", "web", ".pi", "settings.json"), "utf8")).rejects.toThrow();
  });

  it("a session with memory gets the one extension and the five memory tools", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "rovara-pi-memory-"));
    const parts = await piMemorySessionParts(agentDirectory, { project: "web" });
    expect(parts.extensions.map((extension) => (typeof extension === "function" ? "function" : extension.name))).toEqual(["rovara-pi-memory"]);
    expect(parts.tools).toEqual(PI_MEMORY_TOOLS);
  });
});
