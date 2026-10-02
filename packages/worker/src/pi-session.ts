import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  type BashOperations,
  type BashSpawnContext,
  type ModelRuntime,
  type ToolDefinition,
  SessionManager,
  SettingsManager,
  type SessionEntry,
  type SessionStats,
} from "@earendil-works/pi-coding-agent";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import { createModelRuntimeWithFallback } from "@agentx/model-runtime";
import { agentXError, ThinkingLevelSchema, type ThinkingLevel } from "@agentx/contracts";
import { devcontainerContextFile, hostPath, type DevcontainerPaths } from "./devcontainer.js";
import { AGENTX_GIT_IDENTITY_ENVIRONMENT } from "./git.js";
import {
  appendRepositoryContextFiles,
  loadRepositoryContextFiles,
  readPreparedRepositories,
  workspaceRepositoriesNote,
  type RepositoryContextFile,
} from "./repository-context.js";
import type { PiCacheRetention } from "./usage.js";

export type PiThinkingLevel = ThinkingLevel;

export interface WorkspaceModelConfiguration {
  provider: string;
  modelId: string;
  thinkingLevel?: PiThinkingLevel;
  cacheRetention?: PiCacheRetention;
}

export interface PiSessionHandle {
  conversationId: string;
  sessionFile: string;
  prompt(text: string): Promise<void>;
  /** Queues a message the model reads before its next call, while a prompt runs. */
  steer?(text: string): Promise<void>;
  abort(): Promise<void>;
  /** The model and the thinking level the session actually runs with, read back after creation. */
  getModel(): { provider: string; modelId: string; thinkingLevel?: PiThinkingLevel };
  /** Pi's own resolved level, even one outside AgentX's six (Pi's "max"); for artifacts only, never telemetry. */
  piThinkingLevel?(): string | undefined;
  getSessionStats(): SessionStats;
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): void;
}

export interface PiSessionInput {
  cwd: string;
  /** The broker-issued public conversation ID, which Pi's own session ID never replaces. */
  conversationId?: string;
  sessionDirectory: string;
  agentDirectory: string;
  model: WorkspaceModelConfiguration;
  /** AgentX's workspace note, then each prepared repository's own context file, which Pi cannot discover from the root. */
  contextFiles: RepositoryContextFile[];
  /** Where the agent's shell runs instead of the worker: the project's devcontainer (#121). */
  bashOperations?: BashOperations;
  /** The repository's folder in the devcontainer, which the file tools resolve to the host folder (#128). */
  devcontainerPaths?: DevcontainerPaths;
}

export interface PiSessionAdapter {
  create(input: PiSessionInput): Promise<PiSessionHandle>;
  open?(input: PiSessionInput & { conversationId: string; sessionFile: string }): Promise<PiSessionHandle>;
}

export async function createWorkspacePiSession(
  input: {
    rootPath: string;
    model: WorkspaceModelConfiguration;
    conversationId?: string;
    onDiagnostic?: (message: string) => void;
    bashOperations?: BashOperations;
    devcontainerPaths?: DevcontainerPaths;
  },
  adapter: PiSessionAdapter = defaultPiSessionAdapter,
): Promise<PiSessionHandle> {
  const rootPath = await realpath(resolve(input.rootPath));
  const sessionDirectory = resolve(rootPath, "agent-sessions");
  const agentDirectory = resolve(rootPath, ".agentx/pi");
  await Promise.all([
    mkdir(sessionDirectory, { recursive: true, mode: 0o700 }),
    mkdir(agentDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const contextFiles = await loadWorkspaceContextFiles(rootPath, input.onDiagnostic, input.devcontainerPaths);
  const handle = await adapter.create({
    cwd: rootPath,
    sessionDirectory,
    agentDirectory,
    model: input.model,
    contextFiles,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    ...(input.bashOperations === undefined ? {} : { bashOperations: input.bashOperations }),
    ...(input.devcontainerPaths === undefined ? {} : { devcontainerPaths: input.devcontainerPaths }),
  });
  assertContained(sessionDirectory, handle.sessionFile);
  return handle;
}

export async function openRegisteredWorkspacePiSession(
  input: {
    rootPath: string;
    model: WorkspaceModelConfiguration;
    conversationId: string;
    sessionFile: string;
    onDiagnostic?: (message: string) => void;
    bashOperations?: BashOperations;
    devcontainerPaths?: DevcontainerPaths;
  },
  adapter: PiSessionAdapter = defaultPiSessionAdapter,
): Promise<PiSessionHandle> {
  const rootPath = await realpath(resolve(input.rootPath));
  const sessionDirectory = resolve(rootPath, "agent-sessions");
  const agentDirectory = resolve(rootPath, ".agentx/pi");
  const sessionFile = await realpath(resolve(input.sessionFile)).catch(() => {
    throw agentXError(
      "CONVERSATION_STATE_LOST",
      "the saved transcript for this conversation is missing from the workspace",
    );
  });
  assertContained(sessionDirectory, sessionFile);
  if (!adapter.open) throw new Error("pi session adapter does not support saved-session reopen");
  const contextFiles = await loadWorkspaceContextFiles(rootPath, input.onDiagnostic, input.devcontainerPaths);
  const handle = await adapter.open({
    cwd: rootPath,
    sessionDirectory,
    agentDirectory,
    model: input.model,
    contextFiles,
    conversationId: input.conversationId,
    sessionFile,
    ...(input.bashOperations === undefined ? {} : { bashOperations: input.bashOperations }),
    ...(input.devcontainerPaths === undefined ? {} : { devcontainerPaths: input.devcontainerPaths }),
  });
  assertContained(sessionDirectory, handle.sessionFile);
  return handle;
}

/** Resolves the session's model runtime; tests supply an offline one, the worker uses the default. */
export type PiModelRuntimeResolver = (
  model: WorkspaceModelConfiguration,
) => Promise<{ runtime: ModelRuntime; model: WorkspaceModelConfiguration }>;

/** The worker's Pi session adapter. Without `modelRuntime` it resolves the configured model as the worker always has. */
export function createDefaultPiSessionAdapter(options: { modelRuntime?: PiModelRuntimeResolver } = {}): PiSessionAdapter {
  const resolveModelRuntime = options.modelRuntime ?? workerModelRuntime;
  return {
    async create(input) {
      return createDefaultSession(
        input,
        SessionManager.create(input.cwd, input.sessionDirectory),
        resolveModelRuntime,
        input.conversationId,
      );
    },
    async open(input) {
      return createDefaultSession(
        input,
        SessionManager.open(input.sessionFile, input.sessionDirectory, input.cwd),
        resolveModelRuntime,
        input.conversationId,
      );
    },
  };
}

export const defaultPiSessionAdapter: PiSessionAdapter = createDefaultPiSessionAdapter();

async function workerModelRuntime(
  configured: WorkspaceModelConfiguration,
): Promise<{ runtime: ModelRuntime; model: WorkspaceModelConfiguration }> {
  const resolved = await createModelRuntimeWithFallback(configured, "worker");
  const modelRuntime = resolved.runtime;
  if (resolved.model.provider === "amazon-bedrock") {
    modelRuntime.registerNativeProvider(executionRoleBedrockProvider());
    await modelRuntime.refresh({ allowNetwork: false, providers: ["amazon-bedrock"] });
  }
  return { runtime: modelRuntime, model: resolved.model };
}

async function createDefaultSession(
  input: PiSessionInput,
  manager: SessionManager,
  resolveModelRuntime: PiModelRuntimeResolver,
  conversationId?: string,
): Promise<PiSessionHandle> {
    const resolved = await resolveModelRuntime(input.model);
    const modelRuntime = resolved.runtime;
    const model = modelRuntime.getModel(resolved.model.provider, resolved.model.modelId);
    if (!model) {
      throw agentXError(
        "RUNTIME_UNAVAILABLE",
        `configured model ${input.model.provider}/${input.model.modelId} is unavailable`,
      );
    }
    const requestedLevel = input.model.thinkingLevel;
    if (!model.reasoning && requestedLevel !== undefined && requestedLevel !== "off") {
      throw agentXError("CONFIG_INVALID", "the selected model does not support reasoning; set thinkingLevel to off");
    }
    const { resourceLoader, settingsManager } = await createWorkerResources(input);
    const { session } = await createAgentSession({
      cwd: input.cwd,
      agentDir: input.agentDirectory,
      modelRuntime,
      model,
      thinkingLevel: requestedLevel ?? (model.reasoning ? "medium" : "off"),
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      // A custom tool with a built-in's name replaces it.
      customTools: [
        agentShellTool(input.cwd, input.bashOperations),
        ...(input.devcontainerPaths === undefined ? [] : devcontainerFileTools(input.cwd, input.devcontainerPaths)),
      ],
      resourceLoader,
      settingsManager,
      sessionManager: manager,
    });
    const sessionFile = session.sessionFile;
    if (!sessionFile) throw new Error("pi did not create a persisted session file");
    return {
      conversationId: conversationId ?? session.sessionId,
      sessionFile,
      prompt: async (text) => session.prompt(text, { expandPromptTemplates: false }),
      // Pi 0.99 returns a disposition ("handled" | "queued"); the adapter's contract stays Promise<void>.
      steer: async (text) => { await session.steer(text); },
      abort: async () => session.abort(),
      getModel: () => ({
        provider: session.model?.provider ?? resolved.model.provider,
        modelId: session.model?.id ?? resolved.model.modelId,
        // Pi also knows "max", which AgentX does not offer: a level outside ours is left out of telemetry
        // (the key is omitted, never guessed); piThinkingLevel reports it for artifacts.
        ...(ThinkingLevelSchema.safeParse(session.thinkingLevel).success ? { thinkingLevel: session.thinkingLevel as PiThinkingLevel } : {}),
      }),
      piThinkingLevel: () => session.thinkingLevel,
      getSessionStats: () => conversationStats(session.getSessionStats(), session.sessionManager.getEntries()),
      subscribe: (listener) => session.subscribe((event) => { if (!isSystemMessageEvent(event)) listener(withoutStructuredContent(withoutSystemMessages(event))); }),
      dispose: () => session.dispose(),
    };
}

/**
 * Pi 0.86+ records the system prompt and tool set as `system` messages in the transcript and emits
 * message_start/message_end for them. The worker's handle keeps the 0.85.1 view: those events never reach
 * its subscribers, agent_end lists the conversation only (so the task's event log does not gain the whole
 * system prompt), and totalMessages counts the conversation only. The session file keeps them; Pi needs them
 * to resume.
 */
function isSystemMessageEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const { type, message } = event as { type?: unknown; message?: { role?: unknown } };
  return (type === "message_start" || type === "message_end" || type === "message_update") && message?.role === "system";
}

function withoutSystemMessages<T>(event: T): T {
  if (!event || typeof event !== "object") return event;
  const { type, messages } = event as { type?: unknown; messages?: unknown };
  if (type !== "agent_end" || !Array.isArray(messages)) return event;
  return { ...event, messages: messages.filter((message: { role?: unknown } | null) => message?.role !== "system") };
}

// Ruling E (amends D for this field only): bash results carry up to 1 MiB of structuredContent, which only codemode reads;
// in a tool_end event it can pass the broker's 400 KB DynamoDB item limit and poison the whole event batch.
function withoutStructuredContent<T>(event: T): T {
  if (!event || typeof event !== "object") return event;
  const { type, toolName, result } = event as { type?: unknown; toolName?: unknown; result?: unknown };
  if (type !== "tool_execution_end" || toolName !== "bash" || !result || typeof result !== "object" || !("structuredContent" in result)) return event;
  const kept: Record<string, unknown> = { ...result };
  delete kept.structuredContent;
  return { ...event, result: kept };
}

function conversationStats(stats: SessionStats, entries: readonly SessionEntry[]): SessionStats {
  // Pi counts every message entry, as getSessionStats does, so the system ones are counted the same way.
  const system = entries.filter((entry) => entry.type === "message" && entry.message.role === "system").length;
  return { ...stats, totalMessages: stats.totalMessages - system };
}

/**
 * The agent's shell: pi's bash tool, in the project's devcontainer when `operations` says so (#121),
 * with AgentX's git identity in its environment so a commit there works without the agent writing
 * an identity into the repository (#208). It replaces pi's built-in bash tool on purpose, so pi's
 * shell settings (shellCommandPrefix, shellPath) do not apply: AgentX's agent directory has none,
 * and a repository's own pi settings must not change how the agent's shell runs.
 */
/**
 * The worker's Pi settings and resources. Pi trusts its working folder by default: a `.pi/SYSTEM.md` there replaces
 * the system prompt, `.pi/settings.json` changes the default model and thinking level, and skills load from the
 * folder and from the home directory. The worker trusts none of it and loads no skills; AgentX passes the context
 * files itself. One settings manager serves the loader and the session, which would otherwise make its own trusted one.
 */
export async function createWorkerResources(
  input: Pick<PiSessionInput, "cwd" | "agentDirectory" | "contextFiles">,
): Promise<{ resourceLoader: DefaultResourceLoader; settingsManager: SettingsManager }> {
  const settingsManager = SettingsManager.create(input.cwd, input.agentDirectory, { projectTrusted: false });
  // Pi 0.86+ warms prompt caches with extra paid requests during long tool runs by default ("streaming"); 0.85.1 made
  // none. The mode is a global-only setting, so it is written to AgentX's own agent directory.
  settingsManager.setCacheWarmingMode("off");
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDirectory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    agentsFilesOverride: appendRepositoryContextFiles(input.contextFiles),
  });
  await resourceLoader.reload({ resolveProjectTrust: async () => false });
  return { resourceLoader, settingsManager };
}

export function agentShellTool(cwd: string, operations?: BashOperations): ToolDefinition {
  // The typed definition's render callbacks are narrower than customTools' generic slot.
  return createBashToolDefinition(cwd, {
    ...(operations === undefined ? {} : { operations }),
    spawnHook: withAgentXGitIdentity,
  }) as unknown as ToolDefinition;
}

function withAgentXGitIdentity(context: BashSpawnContext): BashSpawnContext {
  return { ...context, env: { ...context.env, ...AGENTX_GIT_IDENTITY_ENVIRONMENT } };
}

export function executionRoleBedrockProvider(): ReturnType<typeof amazonBedrockProvider> {
  const provider = amazonBedrockProvider();
  const apiKey = provider.auth.apiKey;
  if (!apiKey) throw new Error("Amazon Bedrock provider lacks its ambient-credential adapter");
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        ...apiKey,
        check: async () => ({ type: "api_key", source: "worker execution role" }),
        resolve: async () => ({ auth: {}, source: "worker execution role" }),
      },
    },
  };
}

/**
 * pi's file tools, with a path under the devcontainer's repository folder resolved to the same file
 * in the worker (#128). The shell sees both folders; these tools run in the worker.
 */
export function devcontainerFileTools(cwd: string, paths: DevcontainerPaths): ToolDefinition[] {
  const tools = [
    createReadToolDefinition(cwd), createEditToolDefinition(cwd), createWriteToolDefinition(cwd),
    createGrepToolDefinition(cwd), createFindToolDefinition(cwd), createLsToolDefinition(cwd),
  ] as unknown as ToolDefinition[];
  return tools.map((tool) => ({
    ...tool,
    execute: (toolCallId, params, signal, onUpdate, context) => {
      const args = params as { path?: unknown };
      const mapped = typeof args.path === "string" ? { ...args, path: hostPath(paths, args.path) } : args;
      return tool.execute(toolCallId, mapped, signal, onUpdate, context);
    },
  }));
}

/** Reloaded for every session, so an edited context file reaches the next task. */
async function loadWorkspaceContextFiles(
  rootPath: string,
  onDiagnostic?: (message: string) => void,
  devcontainerPaths?: DevcontainerPaths,
): Promise<RepositoryContextFile[]> {
  const repositories = await readPreparedRepositories(rootPath);
  const { files, diagnostics } = await loadRepositoryContextFiles(rootPath, repositories);
  for (const diagnostic of diagnostics) onDiagnostic?.(diagnostic);
  // AgentX's note comes first and is present with or without the repositories' own files.
  const note = workspaceRepositoriesNote(repositories);
  const loaded = note === undefined ? files : [note, ...files];
  return devcontainerPaths === undefined ? loaded : [...loaded, devcontainerContextFile(devcontainerPaths)];
}

function assertContained(parent: string, child: string): void {
  if (!isAbsolute(child)) throw agentXError("FORBIDDEN", "pi session path must be absolute");
  const path = relative(parent, resolve(child));
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw agentXError("FORBIDDEN", "pi session path escaped /mnt/workspace/agent-sessions");
  }
}
