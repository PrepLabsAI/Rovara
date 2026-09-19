import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentXNameSchema, agentXError } from "@agentx/contracts";

export interface ReconnectState {
  schemaVersion: 1;
  projectName: string;
  workspaceId: string;
  conversationId: string;
  eventCursor?: string;
}

export async function saveReconnectState(stateDirectory: string, state: ReconnectState): Promise<void> {
  validateState(state);
  const directory = resolve(stateDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, `connection.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, resolve(directory, `${state.projectName}.json`));
}

export async function loadReconnectState(stateDirectory: string, projectName: string): Promise<ReconnectState> {
  AgentXNameSchema.parse(projectName);
  try {
    const state = JSON.parse(
      await readFile(resolve(stateDirectory, `${projectName}.json`), "utf8"),
    ) as ReconnectState;
    validateState(state);
    return state;
  } catch (error) {
    if (error instanceof SyntaxError || (isNodeError(error) && error.code === "ENOENT")) {
      throw agentXError("NOT_FOUND", "no saved AgentX connection for this project");
    }
    throw error;
  }
}

function validateState(state: ReconnectState): void {
  if (
    state.schemaVersion !== 1 ||
    !AgentXNameSchema.safeParse(state.projectName).success ||
    !isUuid(state.workspaceId) ||
    !isUuid(state.conversationId) ||
    (state.eventCursor !== undefined && typeof state.eventCursor !== "string")
  ) {
    throw agentXError("CONFIG_INVALID", "saved client state is invalid");
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
