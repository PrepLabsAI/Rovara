// Spec 025 phase 25d, FR-038: the admin read routes. Each checks the admin claim only, as today's
// list routes do (A2), and reads by key or by index: no route scans the table, and no route writes.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  ADMIN_FAILURES_DEFAULT_HOURS,
  ADMIN_FAILURES_DEFAULT_LIMIT,
  ADMIN_INDEX_RETENTION_DAYS,
  ADMIN_LIST_MAX,
  ADMIN_USAGE_READ_MAX,
  ADMIN_WORKSPACES_DEFAULT_LIMIT,
  AdminUsageGroupBySchema,
  AgentXNameSchema,
  CHANNEL_MEMBERS_MAX_CHANNELS,
  FailureIndexRecordSchema,
  INDEX_EXPIRY_ATTRIBUTE,
  PROJECT_CATALOG_PK,
  SlackTeamIdSchema,
  TaskUsageTelemetrySchema,
  UsageIndexRecordSchema,
  WORKSPACE_PROJECT_INDEX,
  WorkspaceInstanceSchema,
  WorkspaceStatusSchema,
  agentXError,
  developerTaskPolicy,
  parseSlackThreadSubject,
  redactAndCap,
  slackThreadUrl,
  workspaceRecordFields,
  type AdminBindingsResponse,
  type AdminFailuresResponse,
  type AdminProjectsResponse,
  type AdminUsageResponse,
  type AdminWorkspacesResponse,
  type FailureIndexRecord,
  type ChannelInfoRequest,
  type ChannelInfoResponse,
  type ChannelMembersRequest,
  type ChannelMembersResponse,
  type ProjectDefinition,
  type WorkspaceInstance,
} from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";
import { adminHealth, type AdminHealthProbes } from "./admin-health.js";
import { adminIdentityReader, type AdminMeDependencies } from "./admin-me.js";
import { readWorkspaceLimits } from "../developer/limits.js";
import { taskKey, taskPointerKey } from "../developer/task-records.js";
import { listLimitParam, validTime, workspaceProjectReader, type TurnRecordSource } from "./turns.js";

export interface AdminReadDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  turnRecordsTableName?: string;
  /** The TurnRecords table's byTime reader, where the broker has that table (A9). */
  turns?: TurnRecordSource;
  /** The environment's Slack team (named environments); absent in the legacy deployment. */
  slackTeamId?: string;
  /** DeveloperIdentity's channel-info lookup (R10), where developer sign-in is set up. */
  channelInfo?: (request: ChannelInfoRequest) => Promise<ChannelInfoResponse>;
  /** The stack parameters' workspace limits, used when no setting exists (FR-053). */
  limitDefaults: { member: number; organization: number };
  /** DeveloperIdentity's channel-members lookup, where developer sign-in is set up: a private channel's name for a member admin (A11, Q7). */
  channelMembers?: (request: ChannelMembersRequest) => Promise<ChannelMembersResponse>;
  /** A12: the admin issuer's userinfo and the Slack email lookup; set only by the production bootstrap. */
  me?: AdminMeDependencies;
  /** A13: the health route's probes; Task 13 wires the real ones. A probe left out answers `unknown`. */
  health?: AdminHealthProbes;
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

/** A3's names with each one's latest revision, read once: the read that proves a name also serves the list and the health route. */
export async function adminProjects(deps: AdminReadDependencies, identity: AuthenticatedIdentity): Promise<Array<{ name: string; latest: LatestProjectRecord }>> {
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

/** Slack caps a channel name at 80 characters; the cap leaves room for a redaction marker. */
const CHANNEL_NAME_MAX = 200;

/**
 * A11: names for public channels, privacy for all; `available` is false when no name could be read.
 * A private channel's name is kept only for the IDs `reveal` answers (Q7 as answered: the admin's
 * linked Slack user is a member); without `reveal`, or when it fails, a private channel is ID only.
 */
export async function channelLabels(deps: AdminReadDependencies, channelIds: readonly string[], options: { reveal?: (privateIds: string[]) => Promise<ReadonlySet<string>> } = {}): Promise<{ labels: Map<string, { name?: string; private: boolean }>; available: boolean }> {
  const labels = new Map<string, { name?: string; private: boolean }>();
  const unique = [...new Set(channelIds)].sort();
  if (deps.channelInfo === undefined) return { labels, available: unique.length === 0 };
  // Slack's answers first, then names: a private channel's name is only ever held in this call.
  const found = new Map<string, { name: string; isPrivate: boolean }>();
  let available = true;
  try {
    for (let start = 0; start < unique.length; start += CHANNEL_MEMBERS_MAX_CHANNELS) {
      const answer = await deps.channelInfo({ kind: "channel-info", channelIds: unique.slice(start, start + CHANNEL_MEMBERS_MAX_CHANNELS) });
      if (!answer.ok) {
        available = false;
        break;
      }
      // A channel Slack does not return (deleted, or out of the bot's sight) gets no label, so it is
      // listed by ID without name or privacy; the lookup itself worked, so `available` stays true.
      for (const channel of answer.channels) found.set(channel.channelId, { name: channel.name, isPrivate: channel.isPrivate });
    }
  } catch (error) {
    deps.log({ event: "admin.channel_info_failed", error: error instanceof Error ? error.name : "unknown" });
    available = false;
  }
  const privateIds = [...found].filter(([, channel]) => channel.isPrivate).map(([channelId]) => channelId);
  // Q7 as answered: a private channel's name only for an admin who is a member; any failure keeps the ID only.
  const revealed: ReadonlySet<string> = privateIds.length === 0 || options.reveal === undefined
    ? new Set<string>()
    : await options.reveal(privateIds).catch((error: unknown) => {
      deps.log({ event: "admin.channel_members_failed", error: error instanceof Error ? error.name : "unknown" });
      return new Set<string>();
    });
  for (const [channelId, channel] of found) {
    // A16: a name is text from Slack, so it is redacted and capped before any answer carries it.
    const name = redactAndCap(channel.name, CHANNEL_NAME_MAX).text;
    labels.set(channelId, !channel.isPrivate ? { name, private: false } : revealed.has(channelId) ? { name, private: true } : { private: true });
  }
  return { labels, available };
}

/** One identity reader per `me` dependencies object, so its caches live as long as the handler. */
const readers = new WeakMap<AdminMeDependencies, ReturnType<typeof adminIdentityReader>>();
export function adminReader(deps: AdminReadDependencies): ReturnType<typeof adminIdentityReader> | undefined {
  if (deps.me === undefined) return undefined;
  let reader = readers.get(deps.me);
  if (reader === undefined) {
    reader = adminIdentityReader({ ...deps.me, now: () => deps.now(), log: (entry) => deps.log(entry) });
    readers.set(deps.me, reader);
  }
  return reader;
}

/** A11 (Q7): which of the private channels the admin's linked Slack user (A12) is a member of. */
function memberReveal(deps: AdminReadDependencies, identity: AuthenticatedIdentity, authorization: string | undefined): ((privateIds: string[]) => Promise<ReadonlySet<string>>) | undefined {
  const reader = adminReader(deps);
  const members = deps.channelMembers;
  if (reader === undefined || members === undefined) return undefined;
  // Asked only when a private channel is bound, so a list of public channels needs no userinfo call.
  return async (privateIds) => {
    const slackUserId = (await reader.me(identity, authorization)).slack.userId;
    if (slackUserId === undefined) return new Set();
    const memberOf = new Set<string>();
    for (let start = 0; start < privateIds.length; start += CHANNEL_MEMBERS_MAX_CHANNELS) {
      const answer = await members({ kind: "channel-members", slackUserId, channelIds: privateIds.slice(start, start + CHANNEL_MEMBERS_MAX_CHANNELS) });
      if (!answer.ok) return new Set();
      for (const channelId of answer.memberOf) memberOf.add(channelId);
    }
    return memberOf;
  };
}

async function listBindings(deps: AdminReadDependencies, identity: AuthenticatedIdentity, url: URL, authorization: string | undefined): Promise<AdminBindingsResponse> {
  const asked = url.searchParams.get("team");
  // R24 (A11): an environment that records its Slack team lists that team's bindings only.
  if (asked !== null && deps.slackTeamId !== undefined) throw agentXError("CONFIG_INVALID", "this environment records its Slack team; leave out team");
  const team = asked === null ? deps.slackTeamId : SlackTeamIdSchema.safeParse(asked).success ? asked : null;
  if (team === null) throw agentXError("CONFIG_INVALID", "team must be a Slack team ID, such as T0123456789");
  if (team === undefined) throw agentXError("CONFIG_INVALID", "this environment records no Slack team; send team=<team ID>, such as team=T0123456789");
  const items = await queryAllItems(deps, `SLACK_BINDING#${team}`, "CHANNEL#");
  const rows = items.filter((item) => typeof item.channelId === "string" && typeof item.projectName === "string");
  const reveal = memberReveal(deps, identity, authorization);
  const { labels, available } = await channelLabels(deps, rows.map((item) => String(item.channelId)), reveal === undefined ? {} : { reveal });
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

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const STORAGE_KEYS = new Set(["pk", "sk", "entityType", INDEX_EXPIRY_ATTRIBUTE]);
/** A6: DynamoDB's TTL deletes up to 48 hours late; an item past its expiry is never shown. */
const expired = (deps: AdminReadDependencies, item: Record<string, unknown>) => typeof item[INDEX_EXPIRY_ATTRIBUTE] === "number" && item[INDEX_EXPIRY_ATTRIBUTE] <= Math.floor(deps.now() / 1000);
const withoutKeys = (item: Record<string, unknown>) => Object.fromEntries(Object.entries(item).filter(([key]) => !STORAGE_KEYS.has(key)));

function timeParam(url: URL, name: string, fallback: number): number {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  // turns.ts's check: a date that does not exist (February 31, hour 24) is refused, not rolled over.
  if (!validTime(value)) throw agentXError("CONFIG_INVALID", `${name} must be an ISO 8601 time such as 2026-09-30T00:00:00.000Z`);
  return Date.parse(value);
}

/** A window within the index's 30 days: `since` defaults to `defaultHours` before `until`. */
export function timeWindow(url: URL, now: number, defaultHours: number): { since: string; until: string } {
  const until = timeParam(url, "until", now);
  const since = timeParam(url, "since", until - defaultHours * HOUR_MS);
  if (since > until) throw agentXError("CONFIG_INVALID", "since must be before until");
  if (since < now - ADMIN_INDEX_RETENTION_DAYS * DAY_MS) throw agentXError("CONFIG_INVALID", "AgentX keeps these records 30 days; ask for at most the last 30 days");
  // A7: the window itself spans at most 30 days, so a far-future `until` never walks thousands of day partitions.
  if (until - since > ADMIN_INDEX_RETENTION_DAYS * DAY_MS) throw agentXError("CONFIG_INVALID", "a window spans at most 30 days; move since or until closer together");
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}

export function listLimit(url: URL, fallback: number): number {
  return listLimitParam(url.searchParams.get("limit"), fallback);
}

function projectParam(url: URL): string | undefined {
  const value = url.searchParams.get("project");
  if (value === null) return undefined;
  // Never echoed: a name that is not a project name could be long or carry markup.
  if (!AgentXNameSchema.safeParse(value).success) throw agentXError("CONFIG_INVALID", "project must be an AgentX project name");
  return value;
}

/** A7: day partition by day, newest first, until `limit`; an unreadable item is counted, not shown. */
export async function readFailures(deps: AdminReadDependencies, window: { since: string; until: string }, options: { limit: number; project?: string; category?: string }): Promise<{ failures: FailureIndexRecord[]; skipped: number }> {
  const failures: FailureIndexRecord[] = [];
  let skipped = 0;
  for (let day = Date.parse(window.until.slice(0, 10)); day >= Date.parse(window.since.slice(0, 10)) && failures.length < options.limit; day -= DAY_MS) {
    const pk = `FAILURE#${new Date(day).toISOString().slice(0, 10)}`;
    let start: Record<string, unknown> | undefined;
    do {
      const filters = [...(options.project === undefined ? [] : ["#project = :project"]), ...(options.category === undefined ? [] : ["#category = :category"])];
      const page = await deps.documentClient.send(new QueryCommand({
        TableName: deps.tableName,
        KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high",
        ExpressionAttributeValues: {
          ":pk": pk, ":low": window.since, ":high": `${window.until}￿`,
          ...(options.project === undefined ? {} : { ":project": options.project }),
          ...(options.category === undefined ? {} : { ":category": options.category }),
        },
        ...(filters.length === 0 ? {} : {
          ExpressionAttributeNames: {
            ...(options.project === undefined ? {} : { "#project": "project" }),
            ...(options.category === undefined ? {} : { "#category": "category" }),
          },
        }),
        ...(filters.length === 0 ? {} : { FilterExpression: filters.join(" AND ") }),
        ScanIndexForward: false,
        Limit: ADMIN_LIST_MAX,
        ConsistentRead: true,
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
      for (const item of page.Items ?? []) {
        if (expired(deps, item)) continue;
        const parsed = FailureIndexRecordSchema.safeParse(withoutKeys(item));
        if (!parsed.success) {
          skipped += 1;
          continue;
        }
        if (failures.length < options.limit) failures.push(parsed.data);
      }
      start = page.LastEvaluatedKey;
    } while (start !== undefined && failures.length < options.limit);
  }
  if (skipped > 0) deps.log({ event: "admin.failure_index_unreadable", count: skipped });
  return { failures, skipped };
}

async function listFailures(deps: AdminReadDependencies, url: URL): Promise<AdminFailuresResponse> {
  const window = timeWindow(url, deps.now(), ADMIN_FAILURES_DEFAULT_HOURS);
  const project = projectParam(url);
  const { failures, skipped } = await readFailures(deps, window, { limit: listLimit(url, ADMIN_FAILURES_DEFAULT_LIMIT), ...(project === undefined ? {} : { project }) });
  return { failures, ...window, ...(skipped > 0 ? { skipped } : {}) };
}

interface UsageEntry { project: string; origin: string; requester: string; day: string; turn: boolean; task: boolean; durationMs: number; input: number; output: number; cost: number | null }

/** Slack caps a display name well below this; the cap leaves room for a redaction marker. */
const DISPLAY_NAME_MAX = 200;
/** A16: a developer's display name comes from their identity provider, so it is redacted and capped like a channel name. */
const displayName = (name: string) => redactAndCap(name, DISPLAY_NAME_MAX).text;

const requesterKey = (value: unknown): string => {
  const requester = value as { kind?: string; userId?: string; developerId?: string; name?: string } | undefined;
  if (requester?.kind === "slack" || (requester?.kind === undefined && typeof requester?.userId === "string")) return `slack:${requester.userId}`;
  if (requester?.kind === "developer") {
    // One group per developer: two people can share a display name, or names that redact the same.
    const id = requester.developerId?.slice(0, 8) ?? "unknown";
    return `developer:${requester.name === undefined ? id : `${displayName(requester.name)} (${id})`}`;
  }
  return "none";
};

/** How many unreadable turn records one log line names; the count is always exact. */
const LOGGED_ID_LIMIT = 10;
/**
 * The most turn record pages one usage read takes (at most 100 records evaluated each). The origin
 * filter drops AI-tool records after DynamoDB reads them, so pages, not kept records, bound the time.
 */
const USAGE_TURN_PAGES_MAX = 2 * (ADMIN_USAGE_READ_MAX / ADMIN_LIST_MAX);

/**
 * A9: worker usage items day partition by day, then Slack turn records; at most 5,000 read from
 * each source, and at most USAGE_TURN_PAGES_MAX turn record pages. An item or a turn's usage that no longer parses is counted and logged, never dropped
 * silently; a turn with no usage at all is a known zero (R14).
 */
async function usageEntries(deps: AdminReadDependencies, window: { since: string; until: string }): Promise<{ entries: UsageEntry[]; truncated: boolean; skipped: number }> {
  const entries: UsageEntry[] = [];
  let truncated = false;
  let read = 0;
  let skipped = 0;
  const lastDay = Date.parse(window.until.slice(0, 10));
  for (let day = Date.parse(window.since.slice(0, 10)); day <= lastDay && read < ADMIN_USAGE_READ_MAX; day += DAY_MS) {
    let start: Record<string, unknown> | undefined;
    do {
      const page = await deps.documentClient.send(new QueryCommand({
        TableName: deps.tableName,
        KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high",
        ExpressionAttributeValues: { ":pk": `USAGE#${new Date(day).toISOString().slice(0, 10)}`, ":low": window.since, ":high": `${window.until}\uffff` },
        // Never past the cap: the last page asks only for what remains.
        Limit: Math.min(ADMIN_LIST_MAX, ADMIN_USAGE_READ_MAX - read),
        ConsistentRead: true,
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
      for (const item of page.Items ?? []) {
        read += 1;
        if (expired(deps, item)) continue;
        const parsed = UsageIndexRecordSchema.safeParse(withoutKeys(item));
        if (!parsed.success) {
          skipped += 1;
          continue;
        }
        const usage = parsed.data;
        entries.push({ project: usage.project, origin: usage.origin, requester: requesterKey(usage.requester), day: usage.at.slice(0, 10), turn: false, task: true, durationMs: usage.durationMs, input: usage.inputTokens, output: usage.outputTokens, cost: usage.costUsd });
      }
      start = page.LastEvaluatedKey;
      if (read >= ADMIN_USAGE_READ_MAX) {
        truncated = start !== undefined || day < lastDay;
        start = undefined;
      }
    } while (start !== undefined);
  }
  if (skipped > 0) deps.log({ event: "admin.usage_index_unreadable", count: skipped });
  if (deps.turns !== undefined) {
    const projectOf = workspaceProjectReader(deps.documentClient, deps.tableName);
    const projects = new Map<string, string | undefined>();
    const unreadable: string[] = [];
    let unreadableCount = 0;
    let key: Parameters<TurnRecordSource["page"]>[0]["exclusiveStartKey"];
    let turns = 0;
    let pages = 0;
    do {
      const page = await deps.turns.page({ since: window.since, until: window.until, limit: Math.min(ADMIN_LIST_MAX, ADMIN_USAGE_READ_MAX - turns), nowSeconds: Math.floor(deps.now() / 1000), ...(key === undefined ? {} : { exclusiveStartKey: key }), filter: { origin: "slack" } });
      pages += 1;
      // One lookup per new workspace, all of a page at once, cached across pages (as TurnRecordExport does).
      const unseen = [...new Set(page.items.flatMap((item) => (typeof item.workspaceId === "string" && !projects.has(item.workspaceId) ? [item.workspaceId] : [])))];
      const found = await Promise.all(unseen.map(async (workspaceId) => [workspaceId, await projectOf(workspaceId)] as const));
      for (const [workspaceId, project] of found) projects.set(workspaceId, project);
      for (const item of page.items) {
        const workspaceId = typeof item.workspaceId === "string" ? item.workspaceId : undefined;
        const telemetry = item.usage === undefined ? undefined : TaskUsageTelemetrySchema.safeParse(item.usage);
        if (telemetry?.success === false) {
          unreadableCount += 1;
          if (unreadable.length < LOGGED_ID_LIMIT && typeof item.eventId === "string") unreadable.push(item.eventId);
        }
        const known = telemetry?.success === true ? telemetry.data : undefined;
        entries.push({
          project: (workspaceId === undefined ? undefined : projects.get(workspaceId)) ?? "unknown", origin: "slack", requester: requesterKey(item.requestedBy),
          day: String(item.receivedAt).slice(0, 10), turn: true, task: false, durationMs: 0,
          input: known?.tokens.input ?? 0, output: known?.tokens.output ?? 0,
          // No usage at all is a known zero (R14); usage that no longer parses is an unknown cost.
          cost: telemetry === undefined ? 0 : known === undefined ? null : known.costUsd,
        });
        turns += 1;
      }
      key = page.lastEvaluatedKey;
      if (turns >= ADMIN_USAGE_READ_MAX || pages >= USAGE_TURN_PAGES_MAX) { truncated = truncated || key !== undefined; key = undefined; }
    } while (key !== undefined);
    // IDs only: a turn record holds redacted request and response text, which never reaches a log.
    if (unreadableCount > 0) deps.log({ event: "admin.usage_unreadable", count: unreadableCount, eventIds: unreadable });
  }
  return { entries, truncated, skipped };
}

async function usageSummary(deps: AdminReadDependencies, url: URL): Promise<AdminUsageResponse> {
  const groupBy = AdminUsageGroupBySchema.safeParse(url.searchParams.get("group_by"));
  if (!groupBy.success) throw agentXError("CONFIG_INVALID", "group_by must be project, requester, origin or day");
  const window = timeWindow(url, deps.now(), 24 * 7);
  const { entries, truncated, skipped } = await usageEntries(deps, window);
  const groups = new Map<string, AdminUsageResponse["groups"][number]>();
  for (const entry of entries) {
    const key = entry[groupBy.data];
    const group = groups.get(key) ?? { key, turns: 0, tasks: 0, taskDurationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costUnknown: 0 };
    group.turns += entry.turn ? 1 : 0;
    group.tasks += entry.task ? 1 : 0;
    group.taskDurationMs += entry.durationMs;
    group.inputTokens += entry.input;
    group.outputTokens += entry.output;
    if (entry.cost === null) group.costUnknown += 1;
    else group.costUsd = Math.round((group.costUsd + entry.cost) * 1e6) / 1e6;
    groups.set(key, group);
  }
  // The costliest first, then by key, so the answer reads the same each time.
  const sorted = [...groups.values()].sort((left, right) => right.costUsd - left.costUsd || left.key.localeCompare(right.key));
  return { groupBy: groupBy.data, ...window, groups: sorted, truncated, ...(skipped > 0 ? { skipped } : {}) };
}

/** A10: a project's workspaces from spec 041's byWorkspaceProject index, newest first, at most `cap`. Task 12 counts statuses with it. */
export async function projectWorkspaceRows(deps: AdminReadDependencies, project: string, cap: number): Promise<{ rows: WorkspaceInstance[]; truncated: boolean }> {
  const rows: WorkspaceInstance[] = [];
  let start: Record<string, unknown> | undefined;
  let truncated = false;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      IndexName: WORKSPACE_PROJECT_INDEX.name,
      KeyConditionExpression: "#project = :project",
      ExpressionAttributeNames: { "#project": WORKSPACE_PROJECT_INDEX.partitionKey },
      ExpressionAttributeValues: { ":project": project },
      ScanIndexForward: false,
      Limit: ADMIN_LIST_MAX,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const parsed = WorkspaceInstanceSchema.safeParse(workspaceRecordFields(item));
      if (parsed.success) rows.push(parsed.data);
      else deps.log({ event: "admin.workspace_unreadable", project });
    }
    start = page.LastEvaluatedKey;
    if (rows.length >= cap) {
      truncated = start !== undefined || rows.length > cap;
      start = undefined;
    }
  } while (start !== undefined);
  return { rows: rows.slice(0, cap), truncated };
}

/** A10: a task's ID and developer name, or a Slack thread's link; never a task's title (D22). */
export async function workspaceOwner(deps: AdminReadDependencies, workspace: WorkspaceInstance): Promise<{ origin: "slack" | "ai_tool"; owner: { threadUrl?: string; taskId?: string; developerName?: string } }> {
  const pointer = await getStateItem(deps, taskPointerKey(workspace.id));
  if (typeof pointer?.taskId === "string") {
    const task = await getStateItem(deps, taskKey(pointer.taskId));
    return { origin: "ai_tool", owner: { taskId: pointer.taskId, ...(typeof task?.developerName === "string" ? { developerName: displayName(task.developerName) } : {}) } };
  }
  const thread = await getStateItem(deps, { pk: `SLACK_THREAD#${workspace.ownerKey}`, sk: "META" });
  if (typeof thread?.thread === "string") {
    try {
      return { origin: "slack", owner: { threadUrl: slackThreadUrl(parseSlackThreadSubject(thread.thread)) } };
    } catch {
      // An unreadable subject is shown as no owner, never echoed.
    }
  }
  // No task pointer and no readable thread record: a Slack thread workspace (the only other owner
  // kind), or one an admin prepared, shown without an owner rather than guessed at.
  return { origin: "slack", owner: {} };
}

const counterCount = async (deps: AdminReadDependencies, key: { pk: string; sk: string }): Promise<number> => {
  const count = (await getStateItem(deps, key))?.count;
  return typeof count === "number" && count >= 0 ? count : 0;
};

/** How many workspaces one project's read takes before the route sorts and cuts to `limit`. */
const WORKSPACES_READ_PER_PROJECT = 1_000;

async function listWorkspaces(deps: AdminReadDependencies, identity: AuthenticatedIdentity, url: URL): Promise<AdminWorkspacesResponse> {
  const project = projectParam(url);
  const statusText = url.searchParams.get("status");
  const status = statusText === null ? undefined : WorkspaceStatusSchema.safeParse(statusText);
  if (status !== undefined && !status.success) throw agentXError("CONFIG_INVALID", `status must be one of ${WorkspaceStatusSchema.options.join(", ")}`);
  const limit = listLimit(url, ADMIN_WORKSPACES_DEFAULT_LIMIT);
  const projects = project === undefined ? await adminProjectNames(deps, identity) : [project];
  const found: WorkspaceInstance[] = [];
  let truncated = false;
  for (const name of projects) {
    const { rows, truncated: more } = await projectWorkspaceRows(deps, name, WORKSPACES_READ_PER_PROJECT);
    truncated = truncated || more;
    found.push(...rows.filter((row) => (status === undefined ? row.status !== "CLOSED" : row.status === status.data)));
  }
  found.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (found.length > limit) truncated = true;
  const workspaces: AdminWorkspacesResponse["workspaces"] = [];
  for (const workspace of found.slice(0, limit)) {
    const { origin, owner } = await workspaceOwner(deps, workspace);
    workspaces.push({ id: workspace.id, project: workspace.projectName, origin, owner, status: workspace.status, busy: workspace.activeOperationId !== null, lastActivityAt: workspace.updatedAt });
  }
  const limits = await readWorkspaceLimits(deps.documentClient, deps.tableName, deps.limitDefaults, (entry) => deps.log(entry));
  const organization = deps.slackTeamId === undefined ? 0 : await counterCount(deps, { pk: `SLACK_LIMIT#${deps.slackTeamId}`, sk: "ORGANIZATION" });
  const developerOrganization = await counterCount(deps, { pk: "DEVELOPER_LIMIT#ORGANIZATION", sk: "ORGANIZATION" });
  return {
    workspaces,
    limits: { perPerson: limits.member, perOrganization: limits.organization, source: limits.source },
    counts: { organization, ...(developerOrganization > 0 ? { developerOrganization } : {}) },
    truncated,
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
  "/v1/admin/slack/bindings": (deps, identity, url, request) => listBindings(deps, identity, url, request.headers.authorization),
  "/v1/admin/failures": (deps, _identity, url) => listFailures(deps, url),
  "/v1/admin/usage": (deps, _identity, url) => usageSummary(deps, url),
  "/v1/admin/workspaces": (deps, identity, url) => listWorkspaces(deps, identity, url),
  "/v1/admin/me": async (deps, identity, _url, request) => {
    const reader = adminReader(deps);
    // Without the reader (a test that sets none), only the token's own claims speak.
    return reader === undefined
      ? { issuer: identity.issuer, subject: identity.subject, slack: { linked: false, reason: "no_email" } }
      : reader.me(identity, request.headers.authorization);
  },
  "/v1/admin/health": (deps, identity) => adminHealth(deps, identity),
};
