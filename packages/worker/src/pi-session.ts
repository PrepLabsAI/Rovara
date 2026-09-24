import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import { agentXError } from "@agentx/contracts";
import {
  appendRepositoryContextFiles,
  loadRepositoryContextFiles,
  readPreparedRepositories,
  type RepositoryContextFile,
} from "./repository-context.js";

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface WorkspaceModelConfiguration {
  provider: string;
  modelId: string;
  thinkingLevel?: PiThinkingLevel;
}

export interface PiSessionHandle {
  conversationId: string;
  sessionFile: string;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): void;
}

export interface PiSessionInput {
  cwd: string;
  sessionDirectory: string;
  agentDirectory: string;
  model: WorkspaceModelConfiguration;
  /** Each prepared repository's own context file, which Pi cannot discover from the root. */
  contextFiles: RepositoryContextFile[];
}

export interface PiSessionAdapter {
  create(input: PiSessionInput): Promise<PiSessionHandle>;
  open?(input: PiSessionInput & { conversationId: string; sessionFile: string }): Promise<PiSessionHandle>;
}

export async function createWorkspacePiSession(
  input: {
    rootPath: string;
    model: WorkspaceModelConfiguration;
    onDiagnostic?: (message: string) => void;
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
  const contextFiles = await loadWorkspaceContextFiles(rootPath, input.onDiagnostic);
  const handle = await adapter.create({
    cwd: rootPath,
    sessionDirectory,
    agentDirectory,
    model: input.model,
    contextFiles,
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
  },
  adapter: PiSessionAdapter = defaultPiSessionAdapter,
): Promise<PiSessionHandle> {
  const rootPath = await realpath(resolve(input.rootPath));
  const sessionDirectory = resolve(rootPath, "agent-sessions");
  const agentDirectory = resolve(rootPath, ".agentx/pi");
  const sessionFile = await realpath(resolve(input.sessionFile));
  assertContained(sessionDirectory, sessionFile);
  if (!adapter.open) throw new Error("pi session adapter does not support saved-session reopen");
  const contextFiles = await loadWorkspaceContextFiles(rootPath, input.onDiagnostic);
  const handle = await adapter.open({
    cwd: rootPath,
    sessionDirectory,
    agentDirectory,
    model: input.model,
    contextFiles,
    conversationId: input.conversationId,
    sessionFile,
  });
  assertContained(sessionDirectory, handle.sessionFile);
  return handle;
}

const defaultPiSessionAdapter: PiSessionAdapter = {
  async create(input) {
    return createDefaultSession(input, SessionManager.create(input.cwd, input.sessionDirectory));
  },
  async open(input) {
    return createDefaultSession(
      input,
      SessionManager.open(input.sessionFile, input.sessionDirectory, input.cwd),
      input.conversationId,
    );
  },
};

async function createDefaultSession(
  input: PiSessionInput,
  manager: SessionManager,
  conversationId?: string,
): Promise<PiSessionHandle> {
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    if (input.model.provider === "amazon-bedrock") {
      modelRuntime.registerNativeProvider(agentCoreBedrockProvider());
      await modelRuntime.refresh({ allowNetwork: false, providers: ["amazon-bedrock"] });
    }
    const model = modelRuntime.getModel(input.model.provider, input.model.modelId);
    if (!model) {
      throw agentXError(
        "RUNTIME_UNAVAILABLE",
        `configured model ${input.model.provider}/${input.model.modelId} is unavailable`,
      );
    }
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir: input.agentDirectory,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      agentsFilesOverride: appendRepositoryContextFiles(input.contextFiles),
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: input.cwd,
      agentDir: input.agentDirectory,
      modelRuntime,
      model,
      thinkingLevel: input.model.thinkingLevel ?? "medium",
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      resourceLoader,
      sessionManager: manager,
    });
    const sessionFile = session.sessionFile;
    if (!sessionFile) throw new Error("pi did not create a persisted session file");
    return {
      conversationId: conversationId ?? session.sessionId,
      sessionFile,
      prompt: async (text) => session.prompt(text, { expandPromptTemplates: false }),
      abort: async () => session.abort(),
      subscribe: (listener) => session.subscribe((event) => listener(event)),
      dispose: () => session.dispose(),
    };
}

export function agentCoreBedrockProvider(): ReturnType<typeof amazonBedrockProvider> {
  const provider = amazonBedrockProvider();
  const apiKey = provider.auth.apiKey;
  if (!apiKey) throw new Error("Amazon Bedrock provider lacks its ambient-credential adapter");
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        ...apiKey,
        check: async () => ({ type: "api_key", source: "AgentCore execution role" }),
        resolve: async () => ({ auth: {}, source: "AgentCore execution role" }),
      },
    },
  };
}

/** Reloaded for every session, so an edited context file reaches the next task. */
async function loadWorkspaceContextFiles(
  rootPath: string,
  onDiagnostic?: (message: string) => void,
): Promise<RepositoryContextFile[]> {
  const repositories = await readPreparedRepositories(rootPath);
  const { files, diagnostics } = await loadRepositoryContextFiles(rootPath, repositories);
  for (const diagnostic of diagnostics) onDiagnostic?.(diagnostic);
  return files;
}

function assertContained(parent: string, child: string): void {
  if (!isAbsolute(child)) throw new Error("pi session path must be absolute");
  const path = relative(parent, resolve(child));
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error("pi session path escaped /mnt/workspace/agent-sessions");
  }
}
