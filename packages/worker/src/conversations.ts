import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { agentXError } from "@agentx/contracts";

interface ConversationManifest {
  schemaVersion: 1;
  conversations: Record<string, { sessionFile: string; createdAt: string; updatedAt: string }>;
}

export class WorkspaceConversationStore {
  private readonly rootPath: string;
  private readonly sessionDirectory: string;
  private readonly manifestPath: string;

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
    this.sessionDirectory = resolve(this.rootPath, "agent-sessions");
    this.manifestPath = resolve(this.rootPath, ".agentx/conversations.json");
  }

  async register(sessionFile: string, conversationId = randomUUID()): Promise<string> {
    if (!isUuid(conversationId)) throw agentXError("CONFIG_INVALID", "conversation ID must be a UUID");
    const relativePath = this.relativeSessionPath(sessionFile);
    const manifest = await this.load();
    if (manifest.conversations[conversationId]) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "conversation already exists");
    }
    const now = new Date().toISOString();
    manifest.conversations[conversationId] = { sessionFile: relativePath, createdAt: now, updatedAt: now };
    await this.write(manifest);
    return conversationId;
  }

  async resolve(conversationId: string): Promise<string> {
    if (!isUuid(conversationId)) throw agentXError("NOT_FOUND", "conversation not found");
    const record = (await this.load()).conversations[conversationId];
    if (!record) throw agentXError("NOT_FOUND", "conversation not found");
    return this.absoluteSessionPath(record.sessionFile);
  }

  async createSessionFile(conversationId = randomUUID()): Promise<{ conversationId: string; sessionFile: string }> {
    await mkdir(this.sessionDirectory, { recursive: true, mode: 0o700 });
    const sessionFile = resolve(this.sessionDirectory, `${randomUUID()}.jsonl`);
    await writeFile(sessionFile, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await this.register(sessionFile, conversationId);
    return { conversationId, sessionFile };
  }

  private async load(): Promise<ConversationManifest> {
    try {
      const manifest = JSON.parse(await readFile(this.manifestPath, "utf8")) as ConversationManifest;
      if (manifest.schemaVersion !== 1 || !manifest.conversations) throw new Error("invalid conversation manifest");
      return manifest;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return { schemaVersion: 1, conversations: {} };
      throw error;
    }
  }

  private async write(manifest: ConversationManifest): Promise<void> {
    const directory = resolve(this.rootPath, ".agentx");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = resolve(directory, `conversations.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, this.manifestPath);
  }

  private relativeSessionPath(sessionFile: string): string {
    if (!isAbsolute(sessionFile)) throw agentXError("CONFIG_INVALID", "session file must be server-generated");
    const path = relative(this.sessionDirectory, resolve(sessionFile));
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path) || !path.endsWith(".jsonl")) {
      throw agentXError("CONFIG_INVALID", "session file is outside the workspace session directory");
    }
    return path;
  }

  private absoluteSessionPath(sessionFile: string): string {
    const path = resolve(this.sessionDirectory, sessionFile);
    this.relativeSessionPath(path);
    return path;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
