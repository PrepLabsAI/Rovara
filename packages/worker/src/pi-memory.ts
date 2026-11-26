// Workspace memory for the worker's Pi session, through the published pi-memory extension (@samfp/pi-memory, pinned in package.json).
// The agent saves facts and lessons with its memory tools; before each turn the extension adds the ones that match the prompt. The store is one
// SQLite file per workspace, so what the agent learns lasts for that workspace's later turns and stages, and nowhere else.
//
// The extension runs unchanged; this wrapper decides everything it would otherwise read from the machine or the repository:
//   - where it keeps its store and settings: a folder in the worker's private Pi directory (workerPiDirectory, which no task container mounts),
//     handed to it as its working directory. It never sees the session's real working directory, so a repository's `.pi/settings.json` is never read;
//   - its settings: written by Rovara before every session (store in that folder, matching lessons only, no embeddings, so it makes no network call);
//   - consolidation: its one process (a `pi -p ...` run at session end, which would call a model outside Rovara's gateway) is never started, because
//     its `exec` answers as a failed run, which the extension skips.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
// The package names its entry only in its Pi manifest (`pi.extensions`: ./dist/index.js) and has no `exports` map, so the file is imported by its path.
import memoryExtension from "@samfp/pi-memory/dist/index.js";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

/** The tools the extension registers. The session's tool list names them, or Pi would not offer them. */
export const PI_MEMORY_TOOLS = ["memory_search", "memory_remember", "memory_forget", "memory_lessons", "memory_stats"] as const;

/** The settings the extension reads from `<folder>/.pi/settings.json`: the store in the folder itself, lessons chosen by the prompt, and no embedding block. */
export const PI_MEMORY_SETTINGS = { "pi-memory": { localPath: "." }, memory: { lessonInjection: "selective" } } as const;

/**
 * The folder the workspace's memory lives in, inside the worker's private Pi directory: `memory/<project>`. The extension scopes a `project.<name>.*` fact to the
 * last part of its working directory, and its tool asks the agent for keys like `project.<name>.lang`, so the folder carries the project's name.
 */
export function piMemoryDirectory(agentDirectory: string, project: string): string {
  const name = project.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "") || "project";
  return join(agentDirectory, "memory", name);
}

/** Makes the folder and (re)writes its settings, so a settings file changed since (by anything) never survives into a session. */
export async function preparePiMemoryDirectory(agentDirectory: string, project: string): Promise<string> {
  const folder = piMemoryDirectory(agentDirectory, project);
  await mkdir(join(folder, ".pi"), { recursive: true, mode: 0o700 });
  await writeFile(join(folder, ".pi", "settings.json"), `${JSON.stringify(PI_MEMORY_SETTINGS, undefined, 2)}\n`, { mode: 0o600 });
  return folder;
}

/** What the extension's `exec` answers: a run that failed, so consolidation is skipped and no process starts. */
const NO_PROCESS = Object.freeze({ code: 1, stdout: "", stderr: "", killed: false });

/** The extension API the wrapped extension sees: every event handler gets a context whose working directory is the memory folder, and `exec` starts nothing. */
export function memoryExtensionApi(pi: ExtensionAPI, folder: string): ExtensionAPI {
  const withFolder = (ctx: unknown): unknown => (typeof ctx === "object" && ctx !== null
    ? new Proxy(ctx, { get: (target, key) => (key === "cwd" ? folder : Reflect.get(target, key, target) as unknown) })
    : ctx);
  return new Proxy(pi, {
    get(target, key) {
      if (key === "exec") return async () => NO_PROCESS;
      if (key === "on") {
        return (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
          (target.on as (event: string, handler: (event: unknown, ctx: unknown) => unknown) => unknown)(event, (payload, ctx) => handler(payload, withFolder(ctx)));
      }
      return Reflect.get(target, key, target) as unknown;
    },
  });
}

/** The inline extension for a session whose memory lives in `folder` (see preparePiMemoryDirectory). */
export function piMemoryExtension(folder: string): InlineExtension {
  return { name: "rovara-pi-memory", factory: (pi) => memoryExtension(memoryExtensionApi(pi, folder)) };
}

/** A session's memory option: the project it is for, or nothing for a session without memory. */
export type PiMemoryOption = { project: string } | undefined;

/** The option as a session's input carries it: present only when the session has memory. */
export function memoryOption(memory: PiMemoryOption): { memory?: { project: string } } {
  return memory === undefined ? {} : { memory };
}

/** A task stage's memory: every stage but a review, which judges the work afresh rather than with what the builder remembered. */
export function taskStageMemory(stage: { reviewing: boolean; project: string }): { memory?: { project: string } } {
  return memoryOption(stage.reviewing ? undefined : { project: stage.project });
}

/** What a session with memory adds: the extension (its folder made and its settings written first) and its tools; nothing for a session without memory. */
export async function piMemorySessionParts(agentDirectory: string, memory: PiMemoryOption): Promise<{ extensions: InlineExtension[]; tools: readonly string[] }> {
  if (memory === undefined) return { extensions: [], tools: [] };
  return { extensions: [piMemoryExtension(await preparePiMemoryDirectory(agentDirectory, memory.project))], tools: PI_MEMORY_TOOLS };
}
