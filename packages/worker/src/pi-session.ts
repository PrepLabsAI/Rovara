import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import { agentXError } from "@agentx/contracts";
import { DemoRunLimits } from "./demo-run-limits.js";

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

export interface PiSessionAdapter {
  create(input: {
    cwd: string;
    sessionDirectory: string;
    agentDirectory: string;
    model: WorkspaceModelConfiguration;
    limits?: DemoRunLimits;
  }): Promise<PiSessionHandle>;
  open?(input: {
    cwd: string;
    sessionDirectory: string;
    agentDirectory: string;
    model: WorkspaceModelConfiguration;
    conversationId: string;
    sessionFile: string;
  }): Promise<PiSessionHandle>;
}

export async function createWorkspacePiSession(
  input: {
    rootPath: string;
    model: WorkspaceModelConfiguration;
    limits?: DemoRunLimits;
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
  const handle = await adapter.create({ cwd: rootPath, sessionDirectory, agentDirectory, model: input.model,
    ...(input.limits ? { limits: input.limits } : {}),
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
  },
  adapter: PiSessionAdapter = defaultPiSessionAdapter,
): Promise<PiSessionHandle> {
  const rootPath = await realpath(resolve(input.rootPath));
  const sessionDirectory = resolve(rootPath, "agent-sessions");
  const agentDirectory = resolve(rootPath, ".agentx/pi");
  const sessionFile = await realpath(resolve(input.sessionFile));
  assertContained(sessionDirectory, sessionFile);
  if (!adapter.open) throw new Error("pi session adapter does not support saved-session reopen");
  const handle = await adapter.open({
    cwd: rootPath,
    sessionDirectory,
    agentDirectory,
    model: input.model,
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
  input: {
    cwd: string;
    sessionDirectory: string;
    agentDirectory: string;
    model: WorkspaceModelConfiguration;
    limits?: DemoRunLimits;
  },
  manager: SessionManager,
  conversationId?: string,
): Promise<PiSessionHandle> {
    if (input.limits && (input.model.provider !== "amazon-bedrock" || input.model.modelId !== "amazon.nova-pro-v1:0")) {
      throw agentXError("CONFIG_INVALID", "DEMO_MODEL_UNSUPPORTED");
    }
    input.limits?.assertActive();
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false,
      ...(input.limits ? { modelsPath: null, authPath: resolve(input.agentDirectory, "auth.json") } : {}),
    });
    if (input.model.provider === "amazon-bedrock") {
      modelRuntime.registerNativeProvider(agentCoreBedrockProvider(input.limits));
      await modelRuntime.refresh({ allowNetwork: false, providers: ["amazon-bedrock"] });
    }
    const model = modelRuntime.getModel(input.model.provider, input.model.modelId);
    if (!model) {
      throw agentXError(
        "RUNTIME_UNAVAILABLE",
        `configured model ${input.model.provider}/${input.model.modelId} is unavailable`,
      );
    }
    const settingsManager = input.limits ? SettingsManager.inMemory({
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
      compaction: { enabled: false }, images: { blockImages: true },
    }) : undefined;
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir: input.agentDirectory,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      ...(settingsManager ? { settingsManager } : {}),
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: input.cwd,
      agentDir: input.agentDirectory,
      modelRuntime,
      model,
      thinkingLevel: input.model.thinkingLevel ?? "medium",
      tools: input.limits ? ["read", "edit", "write", "grep", "find", "ls"]
        : ["read", "bash", "edit", "write", "grep", "find", "ls"],
      resourceLoader,
      sessionManager: manager,
      ...(settingsManager ? { settingsManager } : {}),
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

export function agentCoreBedrockProvider(limits?: boolean | DemoRunLimits): ReturnType<typeof amazonBedrockProvider> {
  const provider = amazonBedrockProvider();
  const apiKey = provider.auth.apiKey;
  if (!apiKey) throw new Error("Amazon Bedrock provider lacks its ambient-credential adapter");
  const authenticated = {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        ...apiKey,
        check: async () => ({ type: "api_key" as const, source: "AgentCore execution role" }),
        resolve: async () => ({ auth: {}, source: "AgentCore execution role" }),
      },
    },
  };
  return limits ? (limits === true ? new DemoRunLimits() : limits).wrap(authenticated) : authenticated;
}

function assertContained(parent: string, child: string): void {
  if (!isAbsolute(child)) throw new Error("pi session path must be absolute");
  const path = relative(parent, resolve(child));
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error("pi session path escaped /mnt/workspace/agent-sessions");
  }
}
