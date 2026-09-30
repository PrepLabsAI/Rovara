// Spec 025 phase 25d, FR-038: the admin read routes. Each checks the admin claim only, as today's
// list routes do (A2), and reads by key or by index: no route scans the table, and no route writes.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  CHANNEL_MEMBERS_MAX_CHANNELS,
  PROJECT_CATALOG_PK,
  SlackTeamIdSchema,
  agentXError,
  developerTaskPolicy,
  type AdminBindingsResponse,
  type AdminProjectsResponse,
  type ChannelInfoRequest,
  type ChannelInfoResponse,
  type ProjectDefinition,
} from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";

export interface AdminReadDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  turnRecordsTableName?: string;
  /** The environment's Slack team (named environments); absent in the legacy deployment. */
  slackTeamId?: string;
  /** DeveloperIdentity's channel-info lookup (R10), where developer sign-in is set up. */
  channelInfo?: (request: ChannelInfoRequest) => Promise<ChannelInfoResponse>;
  /** The stack parameters' workspace limits, used when no setting exists (FR-053). */
  limitDefaults: { member: number; organization: number };
  /** Task 11 replaces this field's type with AdminMeDependencies. */
  me?: unknown;
  /** Task 12 replaces this field's type with AdminHealthProbes. */
  health?: unknown;
  now(): number;
  log(entry: Record<string, unknown>): void;
}

/** Every item under `pk` with the sort key prefix, or the first `limit` of them. The broker's developer task actions share it. */
export async function queryAllItems(deps: Pick<AdminReadDependencies, "documentClient" | "tableName">, pk: string, prefix: string, options: { limit?: number; newestFirst?: boolean } = {}): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
      ConsistentRead: true,
      ...(options.newestFirst ? { ScanIndexForward: false } : {}),
      ...(options.limit === undefined ? {} : { Limit: options.limit - items.length }),
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start !== undefined && (options.limit === undefined || items.length < options.limit));
  return items;
}

export async function getStateItem(deps: AdminReadDependencies, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return response.Item;
}

/** The latest revision's record, or undefined when the project has none. */
export async function latestProjectRecord(deps: AdminReadDependencies, name: string): Promise<LatestProjectRecord | undefined> {
  const [item] = await queryAllItems(deps, `PROJECT#${name}`, "REV#", { limit: 1, newestFirst: true });
  if (item === undefined) return undefined;
  return item as unknown as LatestProjectRecord;
}

type LatestProjectRecord = { definition: ProjectDefinition; runtimeBinding: { deploymentMode: string }; registeredAt: string };

/**
 * A3 (Q2): the catalog's names, the environment team's bound projects, and the caller's own
 * membership rows. Sorted and unique; a name is kept only while the project has a revision.
 */
export async function adminProjectNames(deps: AdminReadDependencies, identity: AuthenticatedIdentity): Promise<string[]> {
  return (await adminProjects(deps, identity)).map((project) => project.name);
}

/** A3's names with each one's latest revision, read once: the read that proves a name also serves the list. */
async function adminProjects(deps: AdminReadDependencies, identity: AuthenticatedIdentity): Promise<Array<{ name: string; latest: LatestProjectRecord }>> {
  const [catalog, bindings, memberships] = await Promise.all([
    queryAllItems(deps, PROJECT_CATALOG_PK, "PROJECT#"),
    deps.slackTeamId === undefined ? Promise.resolve([]) : queryAllItems(deps, `SLACK_BINDING#${deps.slackTeamId}`, "CHANNEL#"),
    queryAllItems(deps, `MEMBER#${identity.ownerKey}`, "PROJECT#"),
  ]);
  const names = new Set<string>();
  for (const item of catalog) if (typeof item.name === "string") names.add(item.name);
  for (const item of bindings) if (typeof item.projectName === "string") names.add(item.projectName);
  for (const item of memberships) if (typeof item.projectName === "string") names.add(item.projectName);
  const sorted = [...names].sort();
  const latest = await Promise.all(sorted.map((name) => latestProjectRecord(deps, name)));
  return sorted.flatMap((name, index) => {
    const record = latest[index];
    return record === undefined ? [] : [{ name, latest: record }];
  });
}

type Definition = Omit<ProjectDefinition, "integrations"> & { integrations?: { githubMcp?: unknown; connectors?: Array<{ name?: unknown; type?: unknown }> } };

/** FR-030: name, latest revision, registration time, repositories, mode, connectors and task policy. Never the instructions. */
async function listProjects(deps: AdminReadDependencies, identity: AuthenticatedIdentity): Promise<AdminProjectsResponse> {
  const projects: AdminProjectsResponse["projects"] = [];
  for (const { name, latest } of await adminProjects(deps, identity)) {
    const definition = latest.definition as Definition;
    const connectors = (definition.integrations?.connectors ?? [])
      .filter((entry): entry is { name: string; type: string } => typeof entry.name === "string" && typeof entry.type === "string")
      .map((entry) => ({ name: entry.name, type: entry.type }));
    // A revision from before feature 013 names GitHub MCP directly.
    if (definition.integrations?.githubMcp !== undefined && !connectors.some((entry) => entry.type === "github")) connectors.push({ name: "github", type: "github" });
    projects.push({
      name,
      latestRevision: definition.revision,
      registeredAt: latest.registeredAt,
      repositories: definition.repositories.map((repository) => ({ name: repository.name, url: repository.url })),
      runtimeMode: latest.runtimeBinding.deploymentMode,
      connectors,
      developerTasks: developerTaskPolicy(definition),
    });
  }
  return { projects };
}

/** A11: names for public channels, privacy for all; `available` is false when no name could be read. */
export async function channelLabels(deps: AdminReadDependencies, channelIds: readonly string[]): Promise<{ labels: Map<string, { name?: string; private: boolean }>; available: boolean }> {
  const labels = new Map<string, { name?: string; private: boolean }>();
  const unique = [...new Set(channelIds)].sort();
  if (deps.channelInfo === undefined) return { labels, available: unique.length === 0 };
  try {
    for (let start = 0; start < unique.length; start += CHANNEL_MEMBERS_MAX_CHANNELS) {
      const answer = await deps.channelInfo({ kind: "channel-info", channelIds: unique.slice(start, start + CHANNEL_MEMBERS_MAX_CHANNELS) });
      if (!answer.ok) return { labels, available: false };
      for (const channel of answer.channels) {
        // Until Task 11 adds the member check (Q7 as answered), a private channel stays ID only.
        labels.set(channel.channelId, channel.isPrivate ? { private: true } : { name: channel.name, private: false });
      }
    }
  } catch (error) {
    deps.log({ event: "admin.channel_info_failed", error: error instanceof Error ? error.name : "unknown" });
    return { labels, available: false };
  }
  return { labels, available: true };
}

async function listBindings(deps: AdminReadDependencies, url: URL): Promise<AdminBindingsResponse> {
  const asked = url.searchParams.get("team");
  const team = asked === null ? deps.slackTeamId : SlackTeamIdSchema.safeParse(asked).success ? asked : null;
  if (team === null) throw agentXError("CONFIG_INVALID", "team must be a Slack team ID, such as T0123456789");
  if (team === undefined) throw agentXError("CONFIG_INVALID", "this environment records no Slack team; send team=<team ID>, such as team=T0123456789");
  const items = await queryAllItems(deps, `SLACK_BINDING#${team}`, "CHANNEL#");
  const rows = items.filter((item) => typeof item.channelId === "string" && typeof item.projectName === "string");
  const { labels, available } = await channelLabels(deps, rows.map((item) => String(item.channelId)));
  return {
    bindings: rows
      .map((item) => {
        const label = labels.get(String(item.channelId));
        return {
          teamId: team,
          channelId: String(item.channelId),
          ...(label?.name === undefined ? {} : { channelName: label.name }),
          ...(label === undefined ? {} : { private: label.private }),
          projectName: String(item.projectName),
          updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
        };
      })
      .sort((left, right) => left.channelId.localeCompare(right.channelId)),
    notices: available ? [] : ["channel_names_unavailable"],
  };
}

/** The answer for an admin read route, or undefined when the request is not one. */
export async function routeAdminRead(
  deps: AdminReadDependencies,
  identity: AuthenticatedIdentity,
  request: { method: string; headers: Record<string, string | undefined> },
  url: URL,
): Promise<unknown> {
  if (request.method !== "GET") return undefined;
  const read = ADMIN_READS[url.pathname];
  if (read === undefined) return undefined;
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  return read(deps, identity, url, request);
}

type AdminRead = (deps: AdminReadDependencies, identity: AuthenticatedIdentity, url: URL, request: { headers: Record<string, string | undefined> }) => Promise<unknown>;

/** Each later task adds its route here. */
const ADMIN_READS: Record<string, AdminRead> = {
  "/v1/admin/projects": (deps, identity) => listProjects(deps, identity),
  "/v1/admin/slack/bindings": (deps, _identity, url) => listBindings(deps, url),
};
