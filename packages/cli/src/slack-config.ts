import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentXNameSchema, agentXError } from "@agentx/contracts";

export interface SlackProjectConfiguration {
  schemaVersion: 1;
  projectName: string;
  teamId: string;
  channelId: string;
  allowedUserIds: string[];
}

const TEAM_ID = /^T[A-Z0-9]{8,}$/u;
const CHANNEL_ID = /^[CG][A-Z0-9]{8,}$/u;
const USER_ID = /^[UW][A-Z0-9]{8,}$/u;

export async function saveSlackProjectConfiguration(
  stateDirectory: string,
  configuration: SlackProjectConfiguration,
): Promise<void> {
  const validated = validateSlackProjectConfiguration(configuration);
  const directory = resolve(stateDirectory, validated.projectName);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, `slack.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, resolve(directory, "slack.json"));
}

export async function loadSlackProjectConfiguration(
  stateDirectory: string,
  projectName: string,
): Promise<SlackProjectConfiguration> {
  AgentXNameSchema.parse(projectName);
  try {
    const value: unknown = JSON.parse(
      await readFile(resolve(stateDirectory, projectName, "slack.json"), "utf8"),
    );
    return validateSlackProjectConfiguration(value);
  } catch (error) {
    if (error instanceof SyntaxError || (isNodeError(error) && error.code === "ENOENT")) {
      throw agentXError(
        "CONFIG_INVALID",
        `Slack is not configured for ${projectName}; run agentx --project ${projectName} slack configure`,
      );
    }
    throw error;
  }
}

export function validateSlackProjectConfiguration(value: unknown): SlackProjectConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentXError("CONFIG_INVALID", "Slack project configuration must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "projectName", "teamId", "channelId", "allowedUserIds"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw agentXError("CONFIG_INVALID", "Slack project configuration contains unknown fields");
  }
  if (
    input.schemaVersion !== 1 ||
    !AgentXNameSchema.safeParse(input.projectName).success ||
    typeof input.teamId !== "string" ||
    !TEAM_ID.test(input.teamId) ||
    typeof input.channelId !== "string" ||
    !CHANNEL_ID.test(input.channelId) ||
    !Array.isArray(input.allowedUserIds) ||
    input.allowedUserIds.length < 1 ||
    input.allowedUserIds.length > 64 ||
    input.allowedUserIds.some((entry) => typeof entry !== "string" || !USER_ID.test(entry))
  ) {
    throw agentXError("CONFIG_INVALID", "Slack project configuration is invalid");
  }
  const allowedUserIds = [...new Set(input.allowedUserIds as string[])];
  if (allowedUserIds.length !== input.allowedUserIds.length) {
    throw agentXError("CONFIG_INVALID", "Slack allowed user IDs must be unique");
  }
  return {
    schemaVersion: 1,
    projectName: input.projectName as string,
    teamId: input.teamId,
    channelId: input.channelId,
    allowedUserIds,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
