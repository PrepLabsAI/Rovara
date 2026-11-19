import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { agentXError } from "@agentx/contracts";

export const CONVERSATION_MANIFEST_VERSION = 2 as const;

export interface ConversationModel {
  provider: string;
  modelId: string;
}

/**
 * What Pi's session stats added up to (the whole saved transcript, every operation's calls) at the last moment a usage event for this conversation reached the control plane. The next operation's
 * usage is its stats less this, so a run that died before its event was sent is reported by the retry, and nothing is reported twice. Absent for a conversation started before this was kept.
 */
export interface ReportedUsage {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
}

/** The reported usage of a conversation that has had no model call yet. */
export const NO_REPORTED_USAGE: ReportedUsage = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };

const readableUsage = (value: unknown): ReportedUsage | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const { tokens, cost } = value as { tokens?: Record<string, unknown> | null; cost?: unknown };
  const count = (field: string): number | undefined => {
    const found = tokens?.[field];
    return typeof found === "number" && Number.isFinite(found) && found >= 0 ? found : undefined;
  };
  const input = count("input"); const output = count("output"); const cacheRead = count("cacheRead"); const cacheWrite = count("cacheWrite"); const total = count("total");
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined || total === undefined || typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return undefined;
  return { tokens: { input, output, cacheRead, cacheWrite, total }, cost };
};

/** What the workspace remembers about one public conversation ID. */
export interface ConversationRecord {
  conversationId: string;
  /** Absolute path inside the workspace session directory. */
  sessionFile: string;
  /** The model the transcript was built with, absent for entries written before schema 2. */
  model?: ConversationModel;
  /** See ReportedUsage. */
  reportedUsage?: ReportedUsage;
  createdAt: string;
  updatedAt: string;
}

interface StoredConversation {
  sessionFile: string;
  model?: ConversationModel;
  reportedUsage?: ReportedUsage;
  createdAt: string;
  updatedAt: string;
}

interface ConversationManifest {
  schemaVersion: 1 | 2;
  conversations: Record<string, StoredConversation>;
}

export class WorkspaceConversationStore {
  private readonly rootPath: string;
  private readonly manifestPath: string;

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
    this.manifestPath = resolve(this.rootPath, ".agentx/conversations.json");
  }

  async register(sessionFile: string, conversationId: string = randomUUID(), model?: ConversationModel, reportedUsage?: ReportedUsage): Promise<string> {
    if (!isUuid(conversationId)) throw agentXError("CONFIG_INVALID", "conversation ID must be a UUID");
    const relativePath = relativeSessionPath(await this.sessionDirectory(), sessionFile);
    const manifest = await this.load();
    if (manifest.conversations[conversationId]) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "conversation already exists");
    }
    const now = new Date().toISOString();
    manifest.conversations[conversationId] = {
      sessionFile: relativePath,
      ...(model === undefined ? {} : { model }),
      ...(reportedUsage === undefined ? {} : { reportedUsage }),
      createdAt: now,
      updatedAt: now,
    };
    await this.write(manifest);
    return conversationId;
  }

  async resolve(conversationId: string): Promise<string> {
    const record = await this.tryResolve(conversationId);
    if (!record) throw agentXError("NOT_FOUND", "conversation not found");
    return record.sessionFile;
  }

  /** The registered conversation, or undefined when this workspace has never started it. */
  async tryResolve(conversationId: string): Promise<ConversationRecord | undefined> {
    if (!isUuid(conversationId)) return undefined;
    const record = (await this.load()).conversations[conversationId];
    if (!record) return undefined;
    return {
      conversationId,
      sessionFile: await this.absoluteSessionPath(record.sessionFile),
      ...(record.model === undefined ? {} : { model: record.model }),
      ...(readableUsage(record.reportedUsage) === undefined ? {} : { reportedUsage: readableUsage(record.reportedUsage)! }),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  /** Keeps what the usage events sent so far add up to (see ReportedUsage), once the control plane has taken the event. */
  async recordReportedUsage(conversationId: string, reportedUsage: ReportedUsage): Promise<void> {
    const manifest = await this.load();
    const record = manifest.conversations[conversationId];
    if (!record) throw agentXError("NOT_FOUND", "conversation not found");
    manifest.conversations[conversationId] = { ...record, reportedUsage };
    // The temporary file gets a name of its own kind: keeping the figure must not draw from the run's id sequence, which the run's other records are numbered from.
    await this.write(manifest, `usage-${String(process.pid)}-${String(process.hrtime.bigint())}`);
  }

  /** Records that a registered conversation took another turn, pinning the model it ran on. */
  async recordTurn(conversationId: string, model?: ConversationModel): Promise<void> {
    const manifest = await this.load();
    const record = manifest.conversations[conversationId];
    if (!record) throw agentXError("NOT_FOUND", "conversation not found");
    manifest.conversations[conversationId] = {
      ...record,
      ...(model === undefined ? {} : { model }),
      updatedAt: new Date().toISOString(),
    };
    await this.write(manifest);
  }

  async createSessionFile(
    conversationId: string = randomUUID(),
    model?: ConversationModel,
  ): Promise<{ conversationId: string; sessionFile: string }> {
    await mkdir(resolve(this.rootPath, "agent-sessions"), { recursive: true, mode: 0o700 });
    const sessionFile = resolve(await this.sessionDirectory(), `${randomUUID()}.jsonl`);
    await writeFile(sessionFile, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await this.register(sessionFile, conversationId, model);
    return { conversationId, sessionFile };
  }

  private async load(): Promise<ConversationManifest> {
    try {
      const manifest = JSON.parse(await readFile(this.manifestPath, "utf8")) as ConversationManifest;
      if ((manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) || !manifest.conversations) {
        throw agentXError("CONVERSATION_STATE_LOST", "conversation manifest is not a readable version");
      }
      return manifest;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { schemaVersion: CONVERSATION_MANIFEST_VERSION, conversations: {} };
      }
      if (error instanceof SyntaxError) {
        throw agentXError("CONVERSATION_STATE_LOST", "conversation manifest is corrupt");
      }
      throw error;
    }
  }

  private async write(manifest: ConversationManifest, temporaryName: string = randomUUID()): Promise<void> {
    const directory = resolve(this.rootPath, ".agentx");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = resolve(directory, `conversations.${temporaryName}.tmp`);
    const upgraded = { ...manifest, schemaVersion: CONVERSATION_MANIFEST_VERSION };
    await writeFile(temporary, `${JSON.stringify(upgraded, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, this.manifestPath);
  }

  /** Resolved through symlinks, so it matches the directory the Pi session actually writes to. */
  private async sessionDirectory(): Promise<string> {
    const directory = resolve(this.rootPath, "agent-sessions");
    return realpath(directory).catch(() => directory);
  }

  private async absoluteSessionPath(sessionFile: string): Promise<string> {
    const directory = await this.sessionDirectory();
    const path = resolve(directory, sessionFile);
    relativeSessionPath(directory, path);
    return path;
  }
}

function relativeSessionPath(sessionDirectory: string, sessionFile: string): string {
  if (!isAbsolute(sessionFile)) throw agentXError("CONFIG_INVALID", "session file must be server-generated");
  const path = relative(sessionDirectory, resolve(sessionFile));
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path) || !path.endsWith(".jsonl")) {
    throw agentXError("CONFIG_INVALID", "session file is outside the workspace session directory");
  }
  return path;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
