// Guided onboarding PR 5 (design section 3c; DEC 254l item 8): the broker's half of `/rovara link [project] | unlink | status` and its Link / Unlink presses. The Slack
// Lambda (slack-rovara-front.ts) has already checked Slack's signature over the raw body and handed on only the verified fields, by a direct invoke IAM protects.
//
//   - The company is the one the team's binding names (#836); the person is the one their Slack sign-in made (team + user -> person, as #827 records it: the install's own
//     workspace signs in as `<user>`, any other as `<team>:<user>`), and they must be a live member of THAT company. Anyone else (no Rovara account, an unbound team, a person
//     of another company) gets one answer, "Sign in to Rovara first", which names no project.
//   - Project names are looked up only inside that company; a name of another company's project answers exactly as a missing one, without echoing it.
//   - Every answer is private to the person (ephemeral). Changes need a press: the Link / Unlink button carries a single-use action token (32 random bytes; only its sha256 is
//     stored) bound to company, team, channel, Slack user, person, project and action, for 10 minutes; it is spent once, conditionally on all of them, before anything changes.
//   - The press re-reads company, person and role live, then runs the same link core as the web (slack-channel-link.ts).
import { createHash, randomBytes } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXNameSchema, OrgIdSchema, orgProjectCatalogPk, SLACK_OIDC_ISSUER, SlackChannelIdSchema, SlackUserIdSchema } from "@agentx/contracts";
import { Membership, membershipKey, recordInCompany } from "./company-check.js";
import { ownerKeyForSubject } from "./lambda.js";
import {
  CHANNEL_ARCHIVED, CHANNEL_NO_TOKEN, CHANNEL_NOT_CONNECTED, CHANNEL_SHARED, CHANNEL_UNAVAILABLE, linkChannel, linkedProjectOf, mayLinkProject, projectInCompany,
  unlinkChannel, type ChannelLinker, type SlackChannelContext,
} from "./slack-channel-link.js";
import { ROVARA_LINK_ACTION, ROVARA_UNLINK_ACTION } from "./slack-rovara-front.js";
import { parseBinding, slackWorkspaceTeam, teamKey } from "./slack-workspace-binding.js";

export { ROVARA_LINK_ACTION, ROVARA_UNLINK_ACTION };

export const ROVARA_ACTION_TTL_SECONDS = 600;
/** At most this many projects in the no-name menu (each its own Link button). */
export const ROVARA_MENU_MAX = 10;

export const ROVARA_SIGN_IN_FIRST = "Sign in to Rovara first, then run `/rovara` again.";
export const ROVARA_HELP = "`/rovara link [project]` links this channel to a project, `/rovara unlink` removes the link, `/rovara status` shows it.";
export const ROVARA_IN_A_CHANNEL = "Run `/rovara` in the channel you want to link.";
export const ROVARA_PROJECT_NOT_FOUND = "I couldn't find that project in your company. Type `/rovara link` to pick one.";
export const ROVARA_NOT_ALLOWED = "Only a company owner or admin, or the project's admin, can link or unlink a channel.";
export const ROVARA_NO_PROJECTS = "There is no project you can link here. Ask a company owner or admin.";
export const ROVARA_EXPIRED = "This button has expired. Type `/rovara` again.";
export const ROVARA_CHANGED = "This channel's link changed since. Type `/rovara status` to see it.";
export const ROVARA_NOT_SET_UP = "Linking channels from Slack isn't set up on this Rovara yet.";
export const ROVARA_INVITE = "Rovara can't see this channel yet. Type `/invite @Rovara` here, then press Link again.";

const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Team = z.string().max(32).refine(slackWorkspaceTeam);
/** What the Slack Lambda hands on: verified fields only. `channelId` may be a DM (D...): the command then answers "run it in a channel". */
export const SlackRovaraEventSchema = z.discriminatedUnion("kind", [
  z.object({ source: z.literal("agentx.slack-rovara"), kind: z.literal("command"), teamId: Team, userId: SlackUserIdSchema, channelId: z.string().regex(/^[CGD][A-Z0-9]{2,31}$/),
    text: z.string().max(300) }).strict(),
  z.object({ source: z.literal("agentx.slack-rovara"), kind: z.literal("press"), teamId: Team, userId: SlackUserIdSchema, channelId: SlackChannelIdSchema,
    action: z.enum(["link", "unlink"]), token: Token }).strict(),
]);
export type SlackRovaraEvent = z.infer<typeof SlackRovaraEventSchema>;
export function isSlackRovaraEvent(event: unknown): boolean {
  return event !== null && typeof event === "object" && !Array.isArray(event) && (event as { source?: unknown }).source === "agentx.slack-rovara";
}

/** The answer the Slack Lambda posts to the request's response_url, private to the person. `replaceOriginal`: the press's own message is replaced. */
export interface SlackRovaraAnswer { text: string; blocks?: Array<Record<string, unknown>>; replaceOriginal: boolean }

export interface SlackRovaraContext extends SlackChannelContext {
  /** The install's own Slack workspace (SLACK_TEAM_ID): its people sign in with the subject `<user>`; every other workspace's with `<team>:<user>` (#827). */
  installTeamId?: string;
  /** Where "Sign in to Rovara first" links to (an https address), when the install names one. */
  signInUrl?: string;
}

const StoredAction = z.object({
  entityType: z.literal("SLACK_ROVARA_ACTION"), status: z.literal("live"), action: z.enum(["link", "unlink"]),
  companyId: OrgIdSchema, teamId: Team, channelId: SlackChannelIdSchema, userId: SlackUserIdSchema, personId: z.string().regex(/^[a-f0-9]{64}$/), projectName: AgentXNameSchema,
  createdAt: z.iso.datetime(), expiresAt: z.number().int().positive(),
});
type Bound = Omit<z.infer<typeof StoredAction>, "entityType" | "status" | "createdAt" | "expiresAt">;
/** The State-table row of one action token, keyed by the token's sha256 only. */
export const rovaraActionKey = (token: string) => ({ pk: `SLACK_ROVARA_ACTION#${createHash("sha256").update(token, "utf8").digest("hex")}`, sk: "META" });

// ---- Who is asking ---------------------------------------------------------------------------------------------------------------------------------------------------

/** The person a Slack sign-in from `teamId` as `userId` is (developer-identity's subject rule, #827). */
export function slackSignInPerson(teamId: string, userId: string, installTeamId: string | undefined): string {
  return ownerKeyForSubject(SLACK_OIDC_ISSUER, installTeamId !== undefined && teamId === installTeamId ? userId : `${teamId}:${userId}`);
}

/** The company the team is bound to, and the person (live member of it) the Slack user signed in as. Undefined for anyone else. Reads fail closed (undefined). */
async function whoIsAsking(ctx: SlackRovaraContext, teamId: string, userId: string): Promise<ChannelLinker | undefined> {
  try {
    const binding = await ctx.documentClient.send(new GetCommand({ TableName: ctx.tableName, Key: teamKey(teamId), ConsistentRead: true })) as { Item?: unknown };
    if (binding.Item === undefined) return undefined;
    const row = parseBinding(binding.Item);
    if (row.teamId !== teamId) return undefined;
    const personId = slackSignInPerson(teamId, userId, ctx.installTeamId);
    const membership = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: membershipKey(personId), ConsistentRead: true })) as { Item?: unknown };
    const member = Membership.safeParse(membership.Item);
    if (!member.success || member.data.personId !== personId || member.data.companyId !== row.companyId || member.data.revokedAt !== undefined) return undefined;
    const person = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: { pk: `DEVELOPER#${personId}`, sk: "META" }, ConsistentRead: true })) as { Item?: { revoked?: unknown } };
    if (person.Item === undefined || person.Item.revoked === true) return undefined;
    return { companyId: row.companyId, personId, role: member.data.role };
  } catch { return undefined; }
}

// ---- Messages --------------------------------------------------------------------------------------------------------------------------------------------------------

const channelRef = (channelId: string) => `<#${channelId}>`;
const plain = (text: string, replaceOriginal = false): SlackRovaraAnswer => ({ text, replaceOriginal });
const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
const button = (actionId: string, label: string, token: string, primary: boolean) =>
  ({ type: "button", action_id: actionId, text: { type: "plain_text", text: label }, value: token, ...(primary ? { style: "primary" } : {}) });

function signInFirst(ctx: SlackRovaraContext): SlackRovaraAnswer {
  return plain(ctx.signInUrl === undefined ? ROVARA_SIGN_IN_FIRST : `${ROVARA_SIGN_IN_FIRST} <${ctx.signInUrl}|Open Rovara>`);
}

/** Fixed sentences for the link core's refusals; anything unexpected is "try again". */
function refusalText(error: unknown): string {
  const code = error instanceof Error && "code" in error ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : "";
  if (code === "FORBIDDEN") return ROVARA_NOT_ALLOWED;
  if (code === "NOT_FOUND") return ROVARA_PROJECT_NOT_FOUND;
  if (code === "SLACK_NOT_CONNECTED") return message.endsWith(CHANNEL_NO_TOKEN) ? CHANNEL_NO_TOKEN : CHANNEL_NOT_CONNECTED;
  if (code === "SLACK_CHANNEL_REFUSED") return message.endsWith(CHANNEL_ARCHIVED) ? CHANNEL_ARCHIVED : CHANNEL_SHARED;
  if (code === "SLACK_CHANNEL_TAKEN") return "This channel is already linked to another project. Type `/rovara unlink` first.";
  return CHANNEL_UNAVAILABLE;
}

// ---- Action tokens ---------------------------------------------------------------------------------------------------------------------------------------------------

async function mintActions(ctx: SlackRovaraContext, bound: Bound[]): Promise<string[]> {
  const nowMs = ctx.now();
  const expiresAt = Math.floor(nowMs / 1000) + ROVARA_ACTION_TTL_SECONDS;
  const tokens = bound.map(() => (ctx.wiring.random?.(32) ?? randomBytes(32)).toString("base64url"));
  if (tokens.some((token) => !Token.safeParse(token).success)) throw new Error("random");
  const items = bound.map((fields, index) => ({ Put: { TableName: ctx.tableName, ConditionExpression: "attribute_not_exists(pk)", Item: {
    ...rovaraActionKey(tokens[index]!), entityType: "SLACK_ROVARA_ACTION", status: "live", ...fields, createdAt: new Date(nowMs).toISOString(), expiresAt } } }));
  if (items.length === 1) await ctx.documentClient.send(new PutCommand(items[0]!.Put));
  else await ctx.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  return tokens;
}

/**
 * Spends a live token once, only for the same team, channel, Slack user and action, before its expiry (expiresAt, an ordinary field: the row is refused after 10 minutes).
 * Spending DELETES the row conditionally on all of them, so a replay finds nothing. Tokens never pressed stay (small rows; a later cleanup may remove them).
 */
async function spendAction(ctx: SlackRovaraContext, press: Extract<SlackRovaraEvent, { kind: "press" }>): Promise<z.infer<typeof StoredAction> | undefined> {
  try {
    const key = rovaraActionKey(press.token);
    const nowSeconds = Math.floor(ctx.now() / 1000);
    const response = await ctx.documentClient.send(new GetCommand({ TableName: ctx.tableName, Key: key, ConsistentRead: true })) as { Item?: unknown };
    const row = StoredAction.parse(response.Item);
    if (row.teamId !== press.teamId || row.channelId !== press.channelId || row.userId !== press.userId || row.action !== press.action || row.expiresAt <= nowSeconds) return undefined;
    await ctx.documentClient.send(new DeleteCommand({ TableName: ctx.tableName, Key: key,
      ConditionExpression: "#status = :live AND teamId = :team AND channelId = :channel AND userId = :user AND #action = :action AND expiresAt > :now",
      ExpressionAttributeNames: { "#status": "status", "#action": "action" },
      ExpressionAttributeValues: { ":live": "live", ":team": press.teamId, ":channel": press.channelId,
        ":user": press.userId, ":action": press.action, ":now": nowSeconds } }));
    return row;
  } catch { return undefined; }
}

// ---- The command -----------------------------------------------------------------------------------------------------------------------------------------------------

/** The projects this person may link, inside their company: a company owner or admin, the company's catalog; anyone, the projects they administer. Sorted, capped. */
async function linkableProjects(ctx: SlackRovaraContext, linker: ChannelLinker): Promise<{ names: string[]; more: boolean }> {
  const candidates = new Set<string>();
  if (linker.role === "owner" || linker.role === "admin") {
    const pk = orgProjectCatalogPk(OrgIdSchema.parse(linker.companyId));
    const catalog = await ctx.documentClient.send(new QueryCommand({ TableName: ctx.tableName, ConsistentRead: true, Limit: 50, KeyConditionExpression: "pk = :pk AND begins_with(sk, :project)",
      ExpressionAttributeValues: { ":pk": pk, ":project": "PROJECT#" } })) as { Items?: Array<Record<string, unknown>> };
    for (const item of catalog.Items ?? []) {
      const name = typeof item.sk === "string" ? item.sk.slice("PROJECT#".length) : "";
      if (item.pk === pk && AgentXNameSchema.safeParse(name).success) candidates.add(name);
    }
  }
  const own = await ctx.documentClient.send(new QueryCommand({ TableName: ctx.tableName, ConsistentRead: true, Limit: 50, KeyConditionExpression: "pk = :pk AND begins_with(sk, :project)",
    ExpressionAttributeValues: { ":pk": `MEMBER#${linker.personId}`, ":project": "PROJECT#" } })) as { Items?: Array<Record<string, unknown>> };
  for (const item of own.Items ?? []) {
    const name = typeof item.sk === "string" ? item.sk.slice("PROJECT#".length) : "";
    if (item.role === "administrator" && recordInCompany(item, linker.companyId) && AgentXNameSchema.safeParse(name).success) candidates.add(name);
  }
  const names: string[] = [];
  for (const name of [...candidates].sort().slice(0, 25)) {
    if (await projectInCompany(ctx, linker.companyId, name) && await mayLinkProject(ctx, linker, name)) names.push(name);
  }
  return { names: names.slice(0, ROVARA_MENU_MAX), more: names.length > ROVARA_MENU_MAX || candidates.size > 25 };
}

async function linkCommand(ctx: SlackRovaraContext, linker: ChannelLinker, command: Extract<SlackRovaraEvent, { kind: "command" }>, name: string | undefined): Promise<SlackRovaraAnswer> {
  const channelId = command.channelId;
  const bound = (projectName: string): Bound => ({ action: "link", companyId: linker.companyId, teamId: command.teamId, channelId, userId: command.userId, personId: linker.personId, projectName });
  const current = await linkedProjectOf(ctx, linker.companyId, command.teamId, channelId);
  if (name === undefined) {
    if (current !== undefined) return plain(`${channelRef(channelId)} is already linked to *${current}*. Type \`/rovara unlink\` first to link another project.`);
    const { names, more } = await linkableProjects(ctx, linker);
    if (names.length === 0) return plain(ROVARA_NO_PROJECTS);
    const tokens = await mintActions(ctx, names.map(bound));
    const intro = `Link ${channelRef(channelId)} to which project?${more ? " For a project not listed, type `/rovara link <project>`." : ""}`;
    return { text: intro, replaceOriginal: false, blocks: [section(intro),
      ...names.map((project, index) => ({ ...section(`*${project}*`), accessory: button(ROVARA_LINK_ACTION, "Link", tokens[index]!, true) }))] };
  }
  if (!AgentXNameSchema.safeParse(name).success || !await projectInCompany(ctx, linker.companyId, name)) return plain(ROVARA_PROJECT_NOT_FOUND);
  if (!await mayLinkProject(ctx, linker, name)) return plain(ROVARA_NOT_ALLOWED);
  if (current === name) return plain(`${channelRef(channelId)} is already linked to *${name}*.`);
  if (current !== undefined) return plain(`${channelRef(channelId)} is already linked to *${current}*. Type \`/rovara unlink\` first.`);
  const [token] = await mintActions(ctx, [bound(name)]);
  const text = `Link ${channelRef(channelId)} to *${name}*?`;
  return { text, replaceOriginal: false, blocks: [section(text), { type: "actions", elements: [button(ROVARA_LINK_ACTION, "Link", token!, true)] }] };
}

async function unlinkCommand(ctx: SlackRovaraContext, linker: ChannelLinker, command: Extract<SlackRovaraEvent, { kind: "command" }>): Promise<SlackRovaraAnswer> {
  const current = await linkedProjectOf(ctx, linker.companyId, command.teamId, command.channelId);
  if (current === undefined) return plain(`${channelRef(command.channelId)} isn't linked to a Rovara project.`);
  if (!await mayLinkProject(ctx, linker, current)) return plain(ROVARA_NOT_ALLOWED);
  const [token] = await mintActions(ctx, [{ action: "unlink", companyId: linker.companyId, teamId: command.teamId, channelId: command.channelId, userId: command.userId, personId: linker.personId, projectName: current }]);
  const text = `Unlink ${channelRef(command.channelId)} from *${current}*? Threads already started keep working.`;
  return { text, replaceOriginal: false, blocks: [section(text), { type: "actions", elements: [button(ROVARA_UNLINK_ACTION, "Unlink", token!, false)] }] };
}

async function answerCommand(ctx: SlackRovaraContext, command: Extract<SlackRovaraEvent, { kind: "command" }>): Promise<SlackRovaraAnswer> {
  const linker = await whoIsAsking(ctx, command.teamId, command.userId);
  if (linker === undefined) return signInFirst(ctx);
  const words = command.text.trim().split(/\s+/).filter((word) => word !== "");
  const verb = (words[0] ?? "").toLowerCase();
  if (verb !== "link" && verb !== "unlink" && verb !== "status") return plain(ROVARA_HELP);
  if (!command.channelId.startsWith("C") && !command.channelId.startsWith("G")) return plain(ROVARA_IN_A_CHANNEL);
  if (verb === "status") {
    const current = await linkedProjectOf(ctx, linker.companyId, command.teamId, command.channelId);
    return plain(current === undefined ? `${channelRef(command.channelId)} isn't linked to a Rovara project.` : `${channelRef(command.channelId)} is linked to *${current}*.`);
  }
  if (verb === "unlink") return words.length === 1 ? unlinkCommand(ctx, linker, command) : plain(ROVARA_HELP);
  if (words.length > 2) return plain(ROVARA_PROJECT_NOT_FOUND);
  return linkCommand(ctx, linker, command, words[1]?.toLowerCase());
}

// ---- The press -------------------------------------------------------------------------------------------------------------------------------------------------------

async function answerPress(ctx: SlackRovaraContext, press: Extract<SlackRovaraEvent, { kind: "press" }>): Promise<SlackRovaraAnswer> {
  const row = await spendAction(ctx, press);
  if (row === undefined) return plain(ROVARA_EXPIRED, true);
  // Live again: the team must still be the same company's, and the Slack user still the same live member.
  const linker = await whoIsAsking(ctx, press.teamId, press.userId);
  if (linker === undefined) return { ...signInFirst(ctx), replaceOriginal: true };
  if (linker.companyId !== row.companyId || linker.personId !== row.personId) return plain(ROVARA_EXPIRED, true);
  if (row.action === "unlink") {
    try {
      const outcome = await unlinkChannel(ctx, linker, row.projectName, row.channelId, "slack", row.teamId);
      return plain(outcome === "changed" ? ROVARA_CHANGED : `Unlinked ${channelRef(row.channelId)} from *${row.projectName}*. Threads already started keep working.`, true);
    } catch (error) { return plain(refusalText(error), true); }
  }
  try {
    const outcome = await linkChannel(ctx, linker, row.projectName, row.channelId, "slack", row.teamId);
    if (outcome.status === "linked") {
      return plain(outcome.alreadyLinked && outcome.replaced.length === 0 ? `${channelRef(row.channelId)} is already linked to *${row.projectName}*.`
        : `Linked ${channelRef(row.channelId)} to *${row.projectName}*. Mention @Rovara here to start work.`, true);
    }
    // The bot can't see the channel (a private one it is not in): a fresh button for after the /invite.
    const [token] = await mintActions(ctx, [{ action: "link", companyId: row.companyId, teamId: row.teamId, channelId: row.channelId, userId: row.userId, personId: row.personId, projectName: row.projectName }]);
    return { text: ROVARA_INVITE, replaceOriginal: true, blocks: [section(ROVARA_INVITE), { type: "actions", elements: [button(ROVARA_LINK_ACTION, "Link", token!, true)] }] };
  } catch (error) { return plain(refusalText(error), true); }
}

/** The answer to one verified command or press. Never throws: a failure is the fixed "try again". */
export async function handleSlackRovara(ctx: SlackRovaraContext | undefined, event: SlackRovaraEvent): Promise<SlackRovaraAnswer> {
  if (ctx === undefined) return plain(ROVARA_NOT_SET_UP, event.kind === "press");
  try {
    return event.kind === "command" ? await answerCommand(ctx, event) : await answerPress(ctx, event);
  } catch { return plain(CHANNEL_UNAVAILABLE, event.kind === "press"); }
}

/** The install's sign-in link for "Sign in to Rovara first": an https address without credentials, else none. */
export function slackSignInUrlOf(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 512) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.href === value && !/[<>|\s]/.test(value) ? value : undefined;
  } catch { return undefined; }
}
