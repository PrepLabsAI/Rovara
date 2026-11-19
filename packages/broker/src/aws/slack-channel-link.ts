// Guided onboarding PR 5 (designs-2026-10-30/guided-onboarding-design.md section 3c; DEC 254k, DEC 254l item 8): link a project to one Slack channel of the company's own
// workspace, from the web. The /rovara command (slack-rovara-command.ts) uses the same core.
//
//   GET    /v1/dev/company/slack/channels?project=<p>[&cursor=<c>]          the picker: one page of public channels and the private ones the bot is in (shared ones left out)
//   GET    /v1/dev/company/slack/projects/{project}/channel                 any member: the project's channel(s)
//   PUT    /v1/dev/company/slack/projects/{project}/channel  { channelId }  link: {status:"linked"} or {status:"invite_needed"}
//   POST   /v1/dev/company/slack/projects/{project}/channel/check { channelId }  the "Check" press after /invite: the same as PUT
//   DELETE /v1/dev/company/slack/projects/{project}/channel                 unlink (threads already started keep working, as the CLI's unbind)
//
// Rules:
//   - Company and role are the caller's LIVE membership, read at every call. Linking, unlinking and the picker need a company owner or admin, or that project's administrator.
//   - The workspace is the company's own connected one (#836's record, backed by the team's binding naming the same company); the body never names a workspace or company.
//   - The channel is checked with Slack, with the company's own bot token for its own workspace: a channel Slack does not show that token (another workspace's, or a private
//     one the bot is not in) is never linked; the answer is "invite_needed", which says nothing about any other workspace. Shared (Slack Connect) channels are refused.
//   - The link row is the CLI's own row (SLACK_BINDING#<team> / CHANNEL#<channel>, channelBindingAttributes, updatedBy), written conditionally: absent, or already this project's
//     (first wins; another project's link is never overwritten), in one transaction with the team-binding check and an audit row naming the person.
//   - Unlinking deletes only the link row (conditional on its project), exactly as the CLI's unbind: thread workspaces and records are untouched.
import { randomBytes } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  agentXError, AgentXNameSchema, channelBindingAttributes, companyLog, OrgIdSchema, SLACK_CHANNEL, SlackChannelIdSchema,
} from "@agentx/contracts";
import { projectGrant } from "./admin-actions.js";
import { Membership, membershipKey, ownPartitionRow, recordInCompany } from "./company-check.js";
import { latestRevisionRowFor, namedCompany, slackChannelBindingKeyFor, slackChannelBindingPkFor } from "./company-layout.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import { companyInstallKey } from "./slack-company-install.js";
import { SlackNoToken, type SlackChannelView } from "./slack-install-identity.js";
import { parseBinding, slackWorkspaceTeam, teamKey } from "./slack-workspace-binding.js";

export const SLACK_CHANNELS_PATH = "/v1/dev/company/slack/channels";
const PROJECT_CHANNEL = /^\/v1\/dev\/company\/slack\/projects\/([^/]+)\/channel(\/check)?$/;

export const CHANNEL_LINK_NOT_ALLOWED = "Only a company owner or admin, or this project's admin, can link or unlink its Slack channel.";
export const CHANNEL_NOT_CONNECTED = "Add Rovara to Slack first: this company has no Slack workspace connected.";
export const CHANNEL_NO_TOKEN = "Rovara can't reach your Slack workspace just now. A company owner or admin can add Rovara to Slack again.";
export const CHANNEL_TAKEN = "This channel is already linked to another project. Unlink it there first.";
export const CHANNEL_SHARED = "This channel is shared with another organization, so it can't be linked. Pick a channel only your workspace uses.";
export const CHANNEL_ARCHIVED = "This channel is archived. Pick another channel.";
export const CHANNEL_INVITE = "Type `/invite @Rovara` in the channel, then press Check.";
export const CHANNEL_UNAVAILABLE = "Slack could not be checked just now; try again.";
export const CHANNEL_NOT_LINKED = "This project has no Slack channel linked.";
export const CHANNEL_TOO_MANY = "This project has too many linked channels to change here. Unlink some with the CLI first.";
const PROJECT_NOT_FOUND = "project not found";
const SIGN_IN_AGAIN = "your AgentX sign-in has ended; run agentx login <url> again";

/** At most this many links one team's partition is read for (as #836's disconnect); more refuses before anything changes. */
const TEAM_LINKS_MAX = 500;
/** At most this many other channels of one project are replaced by one link. */
const REPLACED_MAX = 10;

/** What the link core asks of Slack: slack-install-identity.ts's channel calls, with the company's own stored token, in the sign-in Lambda. */
export interface SlackChannelSlack {
  channels(companyId: string, teamId: string, cursor?: string): Promise<{ channels: SlackChannelView[]; nextCursor?: string }>;
  channel(companyId: string, teamId: string, channelId: string): Promise<SlackChannelView | "not_found">;
  join(companyId: string, teamId: string, channelId: string): Promise<boolean>;
}

export interface SlackChannelWiring {
  slack: SlackChannelSlack;
  /** The broker's log sink; every line goes through companyLog. Event names and ids only. */
  log: (entry: Record<string, unknown>) => void;
  /** Tests only: random bytes (audit row suffixes, action tokens). */
  random?: (size: number) => Buffer;
}

export interface SlackChannelContext {
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The State table (bindings, links, projects, memberships of projects, audit rows). */
  tableName: string;
  /** The sign-in table (company memberships, people). */
  signInTableName: string;
  now: () => number;
  wiring: SlackChannelWiring;
}

/** The caller as the link core sees them: a live company member. */
export interface ChannelLinker { companyId: string; personId: string; role: "owner" | "admin" | "member" }

export type LinkOutcome =
  | { status: "linked"; teamId: string; channel: { id: string; name: string; isPrivate: boolean }; alreadyLinked: boolean; replaced: string[] }
  | { status: "invite_needed"; teamId: string; channel: { id: string } };

type Send = (command: unknown) => Promise<unknown>;
const sendOf = (ctx: SlackChannelContext): Send => (command) => ctx.documentClient.send(command);
const bytes = (ctx: SlackChannelContext, size: number) => ctx.wiring.random?.(size) ?? randomBytes(size);

/** Whether this module answers the path (the dispatcher sends it here before anything is read). */
export function isSlackChannelLinkPath(path: string): boolean {
  return path === SLACK_CHANNELS_PATH || PROJECT_CHANNEL.test(path);
}

// ---- Reads ----------------------------------------------------------------------------------------------------------------------------------------------------------

const InstallRecord = z.object({ entityType: z.literal("SLACK_COMPANY_WORKSPACE"), companyId: OrgIdSchema, teamId: z.string(), status: z.enum(["connected", "disconnected"]) });

/** The company's connected workspace: its own Add to Slack record, connected, AND the team's binding naming this company. Undefined otherwise. Throws when unreadable. */
export async function companyTeam(ctx: SlackChannelContext, companyId: string): Promise<string | undefined> {
  const send = sendOf(ctx);
  const response = await send(new GetCommand({ TableName: ctx.tableName, Key: companyInstallKey(companyId), ConsistentRead: true })) as { Item?: unknown };
  if (response.Item === undefined) return undefined;
  const record = InstallRecord.parse(response.Item);
  if (record.companyId !== companyId || !slackWorkspaceTeam(record.teamId) || record.status !== "connected") return undefined;
  const binding = await send(new GetCommand({ TableName: ctx.tableName, Key: teamKey(record.teamId), ConsistentRead: true })) as { Item?: unknown };
  if (binding.Item === undefined) return undefined;
  const row = parseBinding(binding.Item);
  return row.teamId === record.teamId && row.companyId === companyId ? record.teamId : undefined;
}

/** Whether `project` is a registered project of `companyId` (its latest revision's company; an unstamped one is the implicit company's). */
export async function projectInCompany(ctx: SlackChannelContext, companyId: string, project: string): Promise<boolean> {
  if (!AgentXNameSchema.safeParse(project).success) return false;
  // DEC 254zzz80 (R2-F1): a NAMED company's project is its own partition's (the core's order; a row naming another company is absent). The built-in company: as before.
  if (namedCompany(companyId) !== undefined) return await latestRevisionRowFor(ctx.documentClient, ctx.tableName, companyId, project) !== undefined;
  const response = await ctx.documentClient.send(new QueryCommand({ TableName: ctx.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :revision)",
    ExpressionAttributeValues: { ":pk": `PROJECT#${project}`, ":revision": "REV#" }, ScanIndexForward: false, Limit: 1, ConsistentRead: true })) as { Items?: unknown[] };
  const row = response.Items?.[0];
  return row !== undefined && recordInCompany(row, companyId);
}

/** DEC 254l item 8: a company owner or admin, or that project's administrator (its grant in this company). Live. */
export async function mayLinkProject(ctx: SlackChannelContext, linker: ChannelLinker, project: string): Promise<boolean> {
  if (linker.role === "owner" || linker.role === "admin") return true;
  const grant = await projectGrant({ documentClient: ctx.documentClient, tableName: ctx.tableName }, project, linker.personId, linker.companyId);
  return grant?.role === "administrator";
}

interface TeamLink { channelId: string; projectName: string }
/** Every link row of one team (bounded); more than the bound, or an unreadable row, throws. */
async function teamLinks(ctx: SlackChannelContext, companyId: string, teamId: string): Promise<TeamLink[]> {
  // DEC 254zzz80 (R2-F1): a NAMED company's links live only in its own partition (ORG#<company>#SLACK_BINDING#<team>); the built-in company's are the legacy rows.
  const pk = slackChannelBindingPkFor(companyId, teamId);
  const links: TeamLink[] = [];
  let cursor: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    if (++pages > 10) throw new Error("too many");
    const response = await ctx.documentClient.send(new QueryCommand({ TableName: ctx.tableName, ConsistentRead: true, Limit: 100, KeyConditionExpression: "pk = :pk AND begins_with(sk, :channel)",
      ExpressionAttributeValues: { ":pk": pk, ":channel": "CHANNEL#" }, ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }) })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of response.Items ?? []) {
      const channel = SlackChannelIdSchema.safeParse(item.channelId);
      const project = AgentXNameSchema.safeParse(item.projectName);
      if (item.pk !== pk || !channel.success || item.sk !== `CHANNEL#${channel.data}` || item.teamId !== teamId || !project.success) throw new Error("link");
      links.push({ channelId: channel.data, projectName: project.data });
      if (links.length > TEAM_LINKS_MAX) throw new Error("too many");
    }
    cursor = response.LastEvaluatedKey;
  } while (cursor !== undefined);
  return links;
}

/** One channel's link row, or undefined. An unreadable row throws (as reading a binding does today). */
async function channelLink(ctx: SlackChannelContext, companyId: string, teamId: string, channelId: string): Promise<string | undefined> {
  const key = slackChannelBindingKeyFor(companyId, teamId, channelId);
  const response = await ctx.documentClient.send(new GetCommand({ TableName: ctx.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  if (response.Item === undefined) return undefined;
  if (response.Item.pk !== key.pk || response.Item.sk !== key.sk || !ownPartitionRow(response.Item, companyId)) throw new Error("link");
  const project = AgentXNameSchema.safeParse(response.Item.projectName);
  if (!project.success || response.Item.teamId !== teamId || response.Item.channelId !== channelId) throw new Error("link");
  return project.data;
}

/** The project a channel of the company's workspace is linked to, when that project is this company's; undefined when unlinked (or linked outside the company). */
export async function linkedProjectOf(ctx: SlackChannelContext, companyId: string, teamId: string, channelId: string): Promise<string | undefined> {
  const project = await channelLink(ctx, companyId, teamId, channelId);
  return project !== undefined && await projectInCompany(ctx, companyId, project) ? project : undefined;
}

// ---- Writes ---------------------------------------------------------------------------------------------------------------------------------------------------------

/** The company's audit partition for channel links. One row per link or unlink, naming the person. */
export const channelAuditKey = (companyId: string, at: string, action: "LINK" | "UNLINK", channelId: string, suffix: string) =>
  ({ pk: `ORG#${OrgIdSchema.parse(companyId)}#SLACK_CHANNEL_AUDIT`, sk: `${at}#${action}#${channelId}#${suffix}` });

function auditPut(ctx: SlackChannelContext, input: { companyId: string; teamId: string; channelId: string; projectName: string; action: "link" | "unlink"; actor: string; via: "web" | "slack"; at: string; replaced?: string[] }) {
  return { Put: { TableName: ctx.tableName, ConditionExpression: "attribute_not_exists(pk)", Item: {
    ...channelAuditKey(input.companyId, input.at, input.action === "link" ? "LINK" : "UNLINK", input.channelId, bytes(ctx, 6).toString("hex")),
    entityType: "SLACK_CHANNEL_AUDIT", companyId: input.companyId, teamId: input.teamId, channelId: input.channelId, projectName: input.projectName,
    action: input.action, actor: input.actor, via: input.via, at: input.at, ...(input.replaced === undefined || input.replaced.length === 0 ? {} : { replaced: input.replaced }),
  } } };
}

const teamStillOurs = (ctx: SlackChannelContext, teamId: string, companyId: string) =>
  ({ ConditionCheck: { TableName: ctx.tableName, Key: teamKey(teamId), ConditionExpression: "companyId = :company", ExpressionAttributeValues: { ":company": companyId } } });

const isAgentXError = (error: unknown) => error instanceof Error && error.name === "AgentXError";

/** The checks every change starts with: the company's connected workspace, the project in this company, and the person's right to it. */
async function prepare(ctx: SlackChannelContext, linker: ChannelLinker, project: string, expectedTeam?: string): Promise<string> {
  let teamId: string | undefined; let inCompany: boolean;
  try {
    inCompany = await projectInCompany(ctx, linker.companyId, project);
    teamId = inCompany ? await companyTeam(ctx, linker.companyId) : undefined;
  } catch { throw agentXError("RUNTIME_UNAVAILABLE", CHANNEL_UNAVAILABLE); }
  if (!inCompany) throw agentXError("NOT_FOUND", PROJECT_NOT_FOUND);
  let allowed: boolean;
  try { allowed = await mayLinkProject(ctx, linker, project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", CHANNEL_UNAVAILABLE); }
  if (!allowed) throw agentXError("FORBIDDEN", CHANNEL_LINK_NOT_ALLOWED);
  // From Slack (/rovara), the workspace the request came from must be the company's connected one (not, say, an older operator-bound one).
  if (teamId === undefined || (expectedTeam !== undefined && teamId !== expectedTeam)) throw agentXError("SLACK_NOT_CONNECTED", CHANNEL_NOT_CONNECTED);
  return teamId;
}

/** Slack's view of the channel through the company's own token; the fixed refusals for what can't be linked. */
async function checkWithSlack(ctx: SlackChannelContext, companyId: string, teamId: string, channelId: string): Promise<SlackChannelView | "invite_needed"> {
  let channel: SlackChannelView | "not_found";
  try { channel = await ctx.wiring.slack.channel(companyId, teamId, channelId); }
  catch (error) {
    if (error instanceof SlackNoToken) throw agentXError("SLACK_NOT_CONNECTED", CHANNEL_NO_TOKEN);
    throw agentXError("RUNTIME_UNAVAILABLE", CHANNEL_UNAVAILABLE);
  }
  // Not shown to this company's bot: another workspace's channel, or a private one the bot is not in. Nothing is written; the answer names nothing.
  if (channel === "not_found") return "invite_needed";
  if (channel.id !== channelId) throw agentXError("RUNTIME_UNAVAILABLE", CHANNEL_UNAVAILABLE);
  if (channel.isShared) throw agentXError("SLACK_CHANNEL_REFUSED", CHANNEL_SHARED);
  if (channel.isArchived) throw agentXError("SLACK_CHANNEL_REFUSED", CHANNEL_ARCHIVED);
  if (channel.isMember) return channel;
  if (channel.isPrivate) return "invite_needed";
  let joined: boolean;
  try { joined = await ctx.wiring.slack.join(companyId, teamId, channelId); } catch { joined = false; }
  if (!joined) throw agentXError("RUNTIME_UNAVAILABLE", CHANNEL_UNAVAILABLE);
  return { ...channel, isMember: true };
}

/**
 * Links `channelId` to `project` for a live member who may (DEC 254l item 8). First wins: a channel linked to another project is refused, never overwritten. The project's
 * other channels in this workspace are unlinked in the same transaction (the project has one channel; DEC 254k: changeable later).
 */
export async function linkChannel(ctx: SlackChannelContext, linker: ChannelLinker, project: string, channelIdValue: unknown, via: "web" | "slack", expectedTeam?: string): Promise<LinkOutcome> {
  const parsedChannel = SlackChannelIdSchema.safeParse(channelIdValue);
  if (!parsedChannel.success) throw agentXError("CONFIG_INVALID", "a Slack channel id (C... or G...) is required");
  const channelId = parsedChannel.data;
  const teamId = await prepare(ctx, linker, project, expectedTeam);
  let existing: string | undefined; let others: TeamLink[];
  try {
    existing = await channelLink(ctx, linker.companyId, teamId, channelId);
    others = (await teamLinks(ctx, linker.companyId, teamId)).filter((link) => link.projectName === project && link.channelId !== channelId);
  } catch { throw agentXError("RUNTIME_UNAVAILABLE", CHANNEL_UNAVAILABLE); }
  if (existing !== undefined && existing !== project) throw agentXError("SLACK_CHANNEL_TAKEN", CHANNEL_TAKEN);
  if (others.length > REPLACED_MAX) throw agentXError("CONFIG_INVALID", CHANNEL_TOO_MANY);
  const checked = await checkWithSlack(ctx, linker.companyId, teamId, channelId);
  if (checked === "invite_needed") return { status: "invite_needed", teamId, channel: { id: channelId } };
  const channel = { id: checked.id, name: checked.name, isPrivate: checked.isPrivate };
  if (existing === project && others.length === 0) return { status: "linked", teamId, channel, alreadyLinked: true, replaced: [] };
  const at = new Date(ctx.now()).toISOString();
  const row = { ...slackChannelBindingKeyFor(linker.companyId, teamId, channelId),
    ...channelBindingAttributes({ channel: SLACK_CHANNEL, tenant: teamId, space: channelId, projectName: project, updatedAt: at }), updatedBy: linker.personId };
  const replaced = others.map((link) => link.channelId).sort();
  try {
    await ctx.documentClient.send(new TransactWriteCommand({ TransactItems: [
      teamStillOurs(ctx, teamId, linker.companyId),
      { Put: { TableName: ctx.tableName, Item: row, ConditionExpression: "attribute_not_exists(pk) OR projectName = :project", ExpressionAttributeValues: { ":project": project } } },
      ...replaced.map((old) => ({ Delete: { TableName: ctx.tableName, Key: slackChannelBindingKeyFor(linker.companyId, teamId, old),
        ConditionExpression: "projectName = :project", ExpressionAttributeValues: { ":project": project } } })),
      auditPut(ctx, { companyId: linker.companyId, teamId, channelId, projectName: project, action: "link", actor: linker.personId, via, at, replaced }),
    ] }));
  } catch (error) {
    if (isAgentXError(error)) throw error;
    // Lost a race (another project took the channel, or the workspace was disconnected meanwhile): the stored rows decide; nothing was written.
    const now = await channelLink(ctx, linker.companyId, teamId, channelId).catch(() => undefined);
    if (now !== undefined && now !== project) throw agentXError("SLACK_CHANNEL_TAKEN", CHANNEL_TAKEN);
    throw agentXError("RUNTIME_UNAVAILABLE", CHANNEL_UNAVAILABLE);
  }
  companyLog(linker.companyId, ctx.wiring.log)({ event: "slack.channel_linked", teamId, channelId, replaced: replaced.length, via, actor: linker.personId });
  return { status: "linked", teamId, channel, alreadyLinked: existing === project, replaced };
}

/** Deletes link rows of `project` (conditional on the project), with an audit row each. Only the link rows: threads and their workspaces are untouched. */
async function unlinkRows(ctx: SlackChannelContext, linker: ChannelLinker, teamId: string, project: string, channels: string[], via: "web" | "slack"): Promise<void> {
  const at = new Date(ctx.now()).toISOString();
  try {
    await ctx.documentClient.send(new TransactWriteCommand({ TransactItems: [
      teamStillOurs(ctx, teamId, linker.companyId),
      ...channels.flatMap((channelId) => [
        { Delete: { TableName: ctx.tableName, Key: slackChannelBindingKeyFor(linker.companyId, teamId, channelId),
          ConditionExpression: "projectName = :project", ExpressionAttributeValues: { ":project": project } } },
        auditPut(ctx, { companyId: linker.companyId, teamId, channelId, projectName: project, action: "unlink", actor: linker.personId, via, at }),
      ]),
    ] }));
  } catch { throw agentXError("RUNTIME_UNAVAILABLE", CHANNEL_UNAVAILABLE); }
  for (const channelId of channels) companyLog(linker.companyId, ctx.wiring.log)({ event: "slack.channel_unlinked", teamId, channelId, via, actor: linker.personId });
}

/** Unlinks every channel of `project` in the company's workspace (the web's Remove). */
export async function unlinkProject(ctx: SlackChannelContext, linker: ChannelLinker, project: string, via: "web" | "slack"): Promise<{ status: "unlinked"; teamId: string; channels: string[] }> {
  const teamId = await prepare(ctx, linker, project);
  let channels: string[];
  try { channels = (await teamLinks(ctx, linker.companyId, teamId)).filter((link) => link.projectName === project).map((link) => link.channelId).sort(); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", CHANNEL_UNAVAILABLE); }
  if (channels.length === 0) throw agentXError("NOT_FOUND", CHANNEL_NOT_LINKED);
  if (channels.length > REPLACED_MAX) throw agentXError("CONFIG_INVALID", CHANNEL_TOO_MANY);
  await unlinkRows(ctx, linker, teamId, project, channels, via);
  return { status: "unlinked", teamId, channels };
}

/** Unlinks one channel, which must still be linked to `project` (what the person was shown and pressed for); the person needs the right to that project. */
export async function unlinkChannel(ctx: SlackChannelContext, linker: ChannelLinker, project: string, channelId: string, via: "web" | "slack", expectedTeam?: string): Promise<"unlinked" | "changed"> {
  const teamId = await prepare(ctx, linker, project, expectedTeam);
  let now: string | undefined;
  try { now = await channelLink(ctx, linker.companyId, teamId, channelId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", CHANNEL_UNAVAILABLE); }
  if (now !== project) return "changed";
  await unlinkRows(ctx, linker, teamId, project, [channelId], via);
  return "unlinked";
}

// ---- The web routes -------------------------------------------------------------------------------------------------------------------------------------------------

async function liveLinker(ctx: SlackChannelContext, caller: DeveloperCaller, companyId: string): Promise<ChannelLinker> {
  try {
    const response = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: membershipKey(caller.developerId), ConsistentRead: true })) as { Item?: unknown };
    const member = Membership.parse(response.Item);
    if (member.personId !== caller.developerId || member.companyId !== companyId || member.revokedAt !== undefined || !OrgIdSchema.safeParse(companyId).success) throw new Error("membership");
    return { companyId: member.companyId, personId: member.personId, role: member.role };
  } catch { throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN); }
}

function jsonBody(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { return undefined; }
}
const LinkBody = z.object({ channelId: z.string().max(32) }).strict();
const Cursor = z.string().min(1).max(512).regex(/^[A-Za-z0-9=+/_-]+$/);

/** The picker: one Slack page, each channel marked with the project (of this company) it is linked to, if any. */
async function listChannels(ctx: SlackChannelContext, linker: ChannelLinker, url: URL): Promise<unknown> {
  const project = url.searchParams.get("project") ?? "";
  const cursorValue = url.searchParams.get("cursor");
  const cursor = cursorValue === null ? undefined : Cursor.safeParse(cursorValue);
  if (cursor !== undefined && !cursor.success) throw agentXError("CONFIG_INVALID", "the channel list's cursor is not one this list gave");
  const teamId = await prepare(ctx, linker, project);
  let page: { channels: SlackChannelView[]; nextCursor?: string }; let links: TeamLink[];
  try {
    links = await teamLinks(ctx, linker.companyId, teamId);
    page = await ctx.wiring.slack.channels(linker.companyId, teamId, cursor?.data);
  } catch (error) {
    if (error instanceof SlackNoToken) throw agentXError("SLACK_NOT_CONNECTED", CHANNEL_NO_TOKEN);
    throw agentXError("RUNTIME_UNAVAILABLE", CHANNEL_UNAVAILABLE);
  }
  const linked = new Map(links.map((link) => [link.channelId, link.projectName]));
  const projects = new Map<string, boolean>();
  const channels = [];
  for (const channel of page.channels) {
    const linkedProject = linked.get(channel.id);
    // Only a project of this company is named; a link outside it shows as "linked" without a name.
    let ours = linkedProject === undefined ? false : projects.get(linkedProject);
    if (linkedProject !== undefined && ours === undefined) {
      try { ours = await projectInCompany(ctx, linker.companyId, linkedProject); } catch { throw agentXError("RUNTIME_UNAVAILABLE", CHANNEL_UNAVAILABLE); }
      projects.set(linkedProject, ours);
    }
    channels.push({ id: channel.id, name: channel.name, isPrivate: channel.isPrivate, ...(linkedProject === undefined ? {} : { linked: true, ...(ours === true ? { linkedProject } : {}) }) });
  }
  return { workspace: { teamId }, channels, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
}

/** Any member: the project's channel(s) in the company's workspace. */
async function readProjectChannel(ctx: SlackChannelContext, linker: ChannelLinker, project: string): Promise<unknown> {
  try {
    if (!await projectInCompany(ctx, linker.companyId, project)) throw agentXError("NOT_FOUND", PROJECT_NOT_FOUND);
    const teamId = await companyTeam(ctx, linker.companyId);
    if (teamId === undefined) return { workspace: null, channels: [] };
    const channels = (await teamLinks(ctx, linker.companyId, teamId)).filter((link) => link.projectName === project).map((link) => ({ channelId: link.channelId })).sort((a, b) => a.channelId.localeCompare(b.channelId));
    return { workspace: { teamId }, channels };
  } catch (error) {
    if (isAgentXError(error)) throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", CHANNEL_UNAVAILABLE);
  }
}

function linkAnswer(outcome: LinkOutcome) {
  if (outcome.status === "invite_needed") return { status: "invite_needed" as const, workspace: { teamId: outcome.teamId }, channel: outcome.channel, message: CHANNEL_INVITE };
  return { status: "linked" as const, workspace: { teamId: outcome.teamId }, channel: outcome.channel, alreadyLinked: outcome.alreadyLinked, replaced: outcome.replaced };
}

/**
 * The routes. The caller is authenticated and its route row (`full`) applied; `companyId` is its live membership's company (resolveCompany). The membership row is read again
 * here, so a role or company that changed since is what counts.
 */
export async function routeSlackChannelLink(ctx: SlackChannelContext, caller: DeveloperCaller, companyId: string, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const linker = await liveLinker(ctx, caller, companyId);
  if (url.pathname === SLACK_CHANNELS_PATH) {
    if (request.method !== "GET") throw agentXError("NOT_FOUND", "not found");
    return listChannels(ctx, linker, url);
  }
  const match = PROJECT_CHANNEL.exec(url.pathname);
  if (match === null) throw agentXError("NOT_FOUND", "not found");
  let project: string;
  try { project = decodeURIComponent(match[1]!); } catch { throw agentXError("NOT_FOUND", PROJECT_NOT_FOUND); }
  if (!AgentXNameSchema.safeParse(project).success) throw agentXError("NOT_FOUND", PROJECT_NOT_FOUND);
  const check = match[2] !== undefined;
  if (check ? request.method === "POST" : request.method === "PUT") {
    const body = LinkBody.safeParse(jsonBody(request));
    if (!body.success) throw agentXError("CONFIG_INVALID", "linking a Slack channel takes {\"channelId\": \"C...\"}");
    return linkAnswer(await linkChannel(ctx, linker, project, body.data.channelId, "web"));
  }
  if (check) throw agentXError("NOT_FOUND", "not found");
  if (request.method === "GET") return readProjectChannel(ctx, linker, project);
  if (request.method === "DELETE") return unlinkProject(ctx, linker, project, "web");
  throw agentXError("NOT_FOUND", "not found");
}
