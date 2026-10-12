// Sign in with ChatGPT's install settings (#343): an admin's switch (off until turned on) and the
// model tasks prefer when a person's plan allows it. Changed only through the admin change path.
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { CHATGPT_DEFAULT_PREFERRED_MODEL, ChatGptModelIdSchema } from "@agentx/contracts";

export const CHATGPT_SETTINGS_KEY = { pk: "SETTINGS", sk: "CHATGPT" } as const;

export interface ChatGptSettings { enabled: boolean; preferredModel: string }

interface Table { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }

/** The record as stored, or undefined when an admin never changed it. */
export async function readChatGptSettingsRecord(table: Table): Promise<Record<string, unknown> | undefined> {
  const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: CHATGPT_SETTINGS_KEY, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return response.Item;
}

/** The settings in force: off, preferring gpt-6.1-sol, until an admin changes them. A value that cannot be read is ignored. */
export function chatGptSettingsOf(record: Record<string, unknown> | undefined): ChatGptSettings {
  const preferred = ChatGptModelIdSchema.safeParse(record?.preferredModel);
  return { enabled: record?.enabled === true, preferredModel: preferred.success ? preferred.data : CHATGPT_DEFAULT_PREFERRED_MODEL };
}

export async function readChatGptSettings(table: Table): Promise<ChatGptSettings> {
  return chatGptSettingsOf(await readChatGptSettingsRecord(table));
}

/** Writes the whole setting; `via` says how the admin confirmed it, as the workspace limits keep it. */
export async function writeChatGptSettings(table: Table & { now(): number }, admin: { issuer: string; subject: string }, settings: ChatGptSettings, via?: string): Promise<ChatGptSettings & { updatedAt: string }> {
  const updatedAt = new Date(table.now()).toISOString();
  await table.documentClient.send(new PutCommand({
    TableName: table.tableName,
    Item: { ...CHATGPT_SETTINGS_KEY, entityType: "SETTING", enabled: settings.enabled, preferredModel: settings.preferredModel, updatedBy: admin, ...(via === undefined ? {} : { via }), updatedAt },
  }));
  return { ...settings, updatedAt };
}
