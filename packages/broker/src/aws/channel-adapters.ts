import { randomBytes } from "node:crypto";
import { CreateSecretCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  AdapterChannelIdSchema,
  AgentXNameSchema,
  CHANNEL_ADAPTERS_PK,
  ChannelAdapterRecordSchema,
  ChannelAdapterRegistrationSchema,
  ChannelOpaqueIdSchema,
  agentXError,
  channelAdapterKey,
  channelAdapterSecretName,
  channelBindingAttributes,
  channelBindingKey,
  generateWebhookSecret,
  readChannelBindingItem,
  type ChannelAdapterRecord,
  type ChannelAdapterRegistered,
  type ChannelBinding,
} from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";

/**
 * Spec 062 FR-020, FR-024: the channel adapter registry and non-Slack bindings, administrator-only. A deployment
 * without `ChannelAdapterConfiguration` has no adapters, and every route here answers NOT_FOUND.
 */

/** Writes an adapter's signing secret. `put` creates the secret or replaces its value. */
export interface ChannelAdapterSecrets {
  put(name: string, value: string): Promise<void>;
}

export interface ChannelAdapterConfiguration {
  /** This environment's adapter secret prefix, such as `agentx/prod/`; secrets are `<prefix>channel-adapter/<channel>`. */
  secretPrefix: string;
  secrets: ChannelAdapterSecrets;
  now?: () => Date;
}

export interface ChannelAdapterDependencies {
  documentClient: Pick<DynamoDBDocumentClient, "send">;
  tableName: string;
  channelAdapters: ChannelAdapterConfiguration;
  /** Throws FORBIDDEN unless the identity administers the project. */
  requireAdministrator(identity: AuthenticatedIdentity, projectName: string): Promise<void>;
  /** Throws NOT_FOUND unless the project is registered. */
  requireProject(projectName: string): Promise<void>;
}

const now = (deps: ChannelAdapterDependencies) => (deps.channelAdapters.now ?? (() => new Date()))();

function requireAdminClaim(identity: AuthenticatedIdentity): void {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
}

function parseChannel(value: string): string {
  const parsed = AdapterChannelIdSchema.safeParse(decodeURIComponent(value));
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "channel must be a lowercase ID such as whatsapp, and not slack");
  return parsed.data;
}

async function getRow(deps: ChannelAdapterDependencies, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }));
  return response.Item as Record<string, unknown> | undefined;
}

function recordOf(item: Record<string, unknown>): ChannelAdapterRecord {
  return ChannelAdapterRecordSchema.parse({
    channel: item.channel, callbackUrl: item.callbackUrl, capabilities: item.capabilities, projects: item.projects,
    stepUp: item.stepUp, secretName: item.secretName, createdAt: item.createdAt, updatedAt: item.updatedAt, updatedBy: item.updatedBy,
  });
}

export async function getChannelAdapter(deps: Pick<ChannelAdapterDependencies, "documentClient" | "tableName">, channel: string): Promise<ChannelAdapterRecord | undefined> {
  const item = await getRow(deps as ChannelAdapterDependencies, channelAdapterKey(channel));
  return item === undefined ? undefined : recordOf(item);
}

async function requireAdministers(deps: ChannelAdapterDependencies, identity: AuthenticatedIdentity, projects: readonly string[]): Promise<void> {
  for (const project of projects) await deps.requireAdministrator(identity, project);
}

/**
 * Registers an adapter or replaces its settings. The caller must administer every project it names, and every project
 * a replaced registration named. A new adapter, or `rotate`, gets a new signing secret, returned only in this answer.
 * The record is written first, on a condition, and the secret only after it: of two administrators registering at
 * once, the refused one never touches the secret the other was given. Until the secret is written the channel API
 * cannot read it and accepts nothing.
 */
export async function registerChannelAdapter(
  deps: ChannelAdapterDependencies,
  identity: AuthenticatedIdentity,
  channelValue: string,
  body: unknown,
  options: { rotate?: boolean } = {},
): Promise<{ adapter: ChannelAdapterRecord; signingSecret?: string }> {
  requireAdminClaim(identity);
  const channel = parseChannel(channelValue);
  const parsed = ChannelAdapterRegistrationSchema.safeParse(body);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
  const registration = parsed.data;
  for (const project of registration.projects) await deps.requireProject(project);
  await requireAdministers(deps, identity, registration.projects);
  const existingItem = await getRow(deps, channelAdapterKey(channel));
  const existing = existingItem === undefined ? undefined : recordOf(existingItem);
  if (existing !== undefined) await requireAdministers(deps, identity, existing.projects);

  const at = now(deps).toISOString();
  const secretName = channelAdapterSecretName(deps.channelAdapters.secretPrefix, channel);
  const signingSecret = existing === undefined || options.rotate === true ? generateWebhookSecret() : undefined;
  const adapter = ChannelAdapterRecordSchema.parse({
    channel, ...registration, secretName, createdAt: existing?.createdAt ?? at, updatedAt: at, updatedBy: identity.ownerKey,
  });
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: { ...channelAdapterKey(channel), entityType: "CHANNEL_ADAPTER", ...adapter },
      // Two administrators registering at once: the second is refused rather than silently replacing the first.
      ...(existing === undefined
        ? { ConditionExpression: "attribute_not_exists(pk)" }
        : { ConditionExpression: "updatedAt = :updatedAt", ExpressionAttributeValues: { ":updatedAt": existing.updatedAt } }),
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
      throw agentXError("CHANGE_STALE", "the adapter changed while it was being registered; read it and try again");
    }
    throw error;
  }
  if (signingSecret === undefined) return { adapter };
  try {
    await deps.channelAdapters.secrets.put(secretName, signingSecret);
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", "the adapter was saved, but its signing secret could not be written; register it again with rotate=true");
  }
  return { adapter, signingSecret } satisfies ChannelAdapterRegistered;
}

export async function listChannelAdapters(deps: ChannelAdapterDependencies, identity: AuthenticatedIdentity): Promise<{ adapters: ChannelAdapterRecord[] }> {
  requireAdminClaim(identity);
  const adapters: ChannelAdapterRecord[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": CHANNEL_ADAPTERS_PK, ":prefix": "CHANNEL#" },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    }));
    for (const item of response.Items ?? []) adapters.push(recordOf(item));
    start = response.LastEvaluatedKey;
  } while (start !== undefined);
  return { adapters };
}

/**
 * Removes an adapter. Its secret is overwritten with random bytes first, so nothing signed with it is accepted
 * again even if the record delete fails. Its bindings stay, inert: nothing is accepted for an unregistered channel.
 */
export async function deleteChannelAdapter(deps: ChannelAdapterDependencies, identity: AuthenticatedIdentity, channelValue: string): Promise<{ deleted: true; channel: string }> {
  requireAdminClaim(identity);
  const channel = parseChannel(channelValue);
  const existing = await getChannelAdapter(deps, channel);
  if (existing === undefined) throw agentXError("NOT_FOUND", "channel adapter not found");
  await requireAdministers(deps, identity, existing.projects);
  await deps.channelAdapters.secrets.put(existing.secretName, `revoked_${randomBytes(32).toString("base64")}`);
  await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: channelAdapterKey(channel) }));
  return { deleted: true, channel };
}

function spaceRef(channelValue: string, tenantValue: string, spaceValue: string) {
  const channel = parseChannel(channelValue);
  const tenant = ChannelOpaqueIdSchema.safeParse(decodeURIComponent(tenantValue));
  const space = ChannelOpaqueIdSchema.safeParse(decodeURIComponent(spaceValue));
  if (!tenant.success || !space.success) throw agentXError("CONFIG_INVALID", "tenant and space must be 1 to 128 letters, digits or ._:+@=- characters");
  return { channel, tenant: tenant.data, space: space.data };
}

/** FR-024: binds an adapter's space to one of the projects the adapter is registered for. */
export async function putChannelBinding(
  deps: ChannelAdapterDependencies,
  identity: AuthenticatedIdentity,
  channelValue: string,
  tenantValue: string,
  spaceValue: string,
  body: unknown,
): Promise<{ binding: ChannelBinding }> {
  requireAdminClaim(identity);
  const ref = spaceRef(channelValue, tenantValue, spaceValue);
  const projectName = AgentXNameSchema.safeParse((body as { projectName?: unknown } | null)?.projectName);
  if (!projectName.success) throw agentXError("CONFIG_INVALID", "projectName must be a registered project's name");
  const adapter = await getChannelAdapter(deps, ref.channel);
  if (adapter === undefined) throw agentXError("NOT_FOUND", "channel adapter not found; register it first");
  if (!adapter.projects.includes(projectName.data)) throw agentXError("FORBIDDEN", `the ${ref.channel} adapter is not registered for project ${projectName.data}`);
  await deps.requireProject(projectName.data);
  await deps.requireAdministrator(identity, projectName.data);
  const existing = readChannelBindingItem(ref, await getRow(deps, channelBindingKey(ref)));
  if (existing !== undefined && existing.projectName !== projectName.data) await deps.requireAdministrator(identity, existing.projectName);
  const binding: ChannelBinding = { ...ref, projectName: projectName.data, updatedAt: now(deps).toISOString() };
  await deps.documentClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: { ...channelBindingKey(ref), ...channelBindingAttributes(binding), updatedBy: identity.ownerKey },
  }));
  return { binding };
}

export async function deleteChannelBinding(
  deps: ChannelAdapterDependencies,
  identity: AuthenticatedIdentity,
  channelValue: string,
  tenantValue: string,
  spaceValue: string,
): Promise<{ deleted: true; binding: ChannelBinding }> {
  requireAdminClaim(identity);
  const ref = spaceRef(channelValue, tenantValue, spaceValue);
  const binding = readChannelBindingItem(ref, await getRow(deps, channelBindingKey(ref)));
  if (binding === undefined) throw agentXError("NOT_FOUND", "channel binding not found");
  await deps.requireAdministrator(identity, binding.projectName);
  await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: channelBindingKey(ref) }));
  return { deleted: true, binding };
}

/** Secrets Manager: replaces the value, or creates the secret on first use. */
export function secretsManagerAdapterSecrets(client: { send(command: CreateSecretCommand | PutSecretValueCommand): Promise<unknown> }): ChannelAdapterSecrets {
  return {
    async put(name, value) {
      try {
        await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "ResourceNotFoundException") throw error;
        await client.send(new CreateSecretCommand({ Name: name, SecretString: value }));
      }
    },
  };
}
