import { agentXError } from "@agentx/contracts";
import type { SecretStore } from "./secret-store.js";

export interface SlackCredentials {
  appToken: string;
  botToken: string;
}

export async function saveSlackCredentials(
  store: SecretStore,
  projectName: string,
  credentials: SlackCredentials,
): Promise<void> {
  validateSlackCredentials(credentials);
  await store.set(credentialKey(projectName), JSON.stringify(credentials));
}

export async function loadSlackCredentials(
  store: SecretStore,
  projectName: string,
): Promise<SlackCredentials> {
  const serialized = await store.get(credentialKey(projectName));
  if (!serialized) {
    throw agentXError(
      "AUTH_REQUIRED",
      `Slack credentials are not stored for ${projectName}; import them with agentx --project ${projectName} slack login`,
    );
  }
  try {
    const value: unknown = JSON.parse(serialized);
    return validateSlackCredentials(value);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw agentXError("AUTH_REQUIRED", "stored Slack credentials are invalid");
    }
    throw error;
  }
}

export async function deleteSlackCredentials(store: SecretStore, projectName: string): Promise<void> {
  await store.delete(credentialKey(projectName));
}

export function validateSlackCredentials(value: unknown): SlackCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentXError("AUTH_REQUIRED", "Slack credentials are invalid");
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => key !== "appToken" && key !== "botToken") ||
    typeof input.appToken !== "string" ||
    !input.appToken.startsWith("xapp-") ||
    input.appToken.length <= "xapp-".length ||
    typeof input.botToken !== "string" ||
    !input.botToken.startsWith("xoxb-") ||
    input.botToken.length <= "xoxb-".length
  ) {
    throw agentXError(
      "AUTH_REQUIRED",
      "Slack credentials require an xapp- app token and an xoxb- bot token",
    );
  }
  return { appToken: input.appToken, botToken: input.botToken };
}

function credentialKey(projectName: string): string {
  return `slack:${projectName}`;
}
