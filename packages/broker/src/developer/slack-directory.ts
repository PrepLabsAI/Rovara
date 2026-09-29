// Spec 025 FR-007, FR-012 and FR-013 with the bot token. Every failure to reach Slack is
// "unavailable": the caller fails closed for access and keeps sessions for refreshes (R18).
import { CHANNEL_MEMBERS_MAX_CHANNELS, type ChannelInfoResponse, type ChannelMembersResponse } from "@agentx/contracts";

export type SlackUserStatus = "active" | "gone" | "unavailable";
export interface SlackDirectory {
  userStatus(userId: string): Promise<SlackUserStatus>;
  lookupByEmail(email: string): Promise<{ userId: string } | "none" | "unavailable">;
  channelMembers(userId: string, channelIds: readonly string[]): Promise<ChannelMembersResponse>;
  /**
   * R10: each channel's name and privacy, cached like members (so a channel made private shows as
   * public for up to 10 minutes). A channel Slack does not know is left out; so are channels past
   * the per-request call budget or after Slack fails midway, which the caller lists by ID.
   */
  channelInfo(channelIds: readonly string[]): Promise<ChannelInfoResponse>;
}

/**
 * Why a Slack call counted as "unavailable": the Web API method, the HTTP status (undefined when
 * Slack could not be reached) and Slack's short error code, so an operator can tell a
 * misconfiguration (invalid_auth, missing_scope, token_revoked) from an outage. Never a token.
 */
export interface SlackProblem { method: string; status: number | undefined; error: string }

export const CHANNEL_MEMBERS_CACHE_MS = 600_000;
const CACHE_CAP = 500;
const TIMEOUT_MS = 5_000;
/** Cold conversations.info calls one channelInfo request may make: names are only for display. */
export const CHANNEL_INFO_MAX_CALLS = 20;
/** Matched to the contract's batch: every channel of a full cold batch, twice (a second page each). */
const MAX_CALLS_PER_REQUEST = 2 * CHANNEL_MEMBERS_MAX_CHANNELS;

interface SlackUser { id?: string; team_id?: string; deleted?: boolean; is_bot?: boolean; enterprise_user?: { teams?: string[] } }
type Reply = { status: number; body: Record<string, unknown> };
type Budget = { left: number };

const errorCode = (error: unknown): string | undefined => {
  const code = typeof error === "string" ? error.replace(/[^a-z_]/g, "").slice(0, 64) : "";
  return code === "" ? undefined : code;
};

export function slackDirectory(input: {
  teamId: string | undefined; botToken: () => Promise<string>; fetch: typeof fetch; now: () => number; cacheMs?: number; maxPages?: number;
  /** Calls one channelMembers request may make on a cold cache, across all its channels. */
  maxCallsPerRequest?: number;
  /** Cold calls one channelInfo request may make. */
  maxInfoCallsPerRequest?: number;
  report?: (problem: SlackProblem) => void;
}): SlackDirectory {
  const cacheMs = input.cacheMs ?? CHANNEL_MEMBERS_CACHE_MS;
  const maxPages = input.maxPages ?? 50;
  const maxCalls = input.maxCallsPerRequest ?? MAX_CALLS_PER_REQUEST;
  const maxInfoCalls = input.maxInfoCallsPerRequest ?? CHANNEL_INFO_MAX_CALLS;
  const members = new Map<string, { at: number; users: Set<string> }>();
  const loading = new Map<string, Promise<Set<string> | undefined>>();
  const info = new Map<string, { at: number; name: string; isPrivate: boolean }>();

  const problem = (method: string, status: number | undefined, error: string): undefined => {
    input.report?.({ method, status, error });
    return undefined;
  };

  /** Slack's reply, or undefined (already reported) when Slack could not answer. */
  const get = async (method: string, query: Record<string, string>): Promise<Reply | undefined> => {
    let token: string;
    try {
      token = await input.botToken();
    } catch {
      return problem(method, undefined, "bot_token_unavailable");
    }
    let response: Response;
    try {
      const url = new URL(`https://slack.com/api/${method}`);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      response = await input.fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      return problem(method, undefined, "unreachable");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : undefined;
    if (response.status === 429 || response.status >= 500 || record === undefined) {
      return problem(method, response.status, errorCode(record?.error) ?? `http_${response.status}`);
    }
    return { status: response.status, body: record };
  };
  /** A reply Slack refused for a reason that says nothing about the person: report it, unavailable. */
  const refused = (method: string, reply: Reply): undefined => problem(method, reply.status, errorCode(reply.body.error) ?? "no_error_code");

  const inTeam = (user: SlackUser) =>
    user.deleted !== true && user.is_bot === false && (user.team_id === input.teamId || (user.enterprise_user?.teams ?? []).includes(input.teamId ?? ""));
  const userOf = (body: Record<string, unknown>): SlackUser => (typeof body.user === "object" && body.user !== null ? body.user : {});

  const loadChannel = async (channelId: string, budget: Budget): Promise<Set<string> | undefined> => {
    const users = new Set<string>();
    let cursor = "";
    for (let page = 0; ; page += 1) {
      if (page >= maxPages) return problem("conversations.members", undefined, "too_many_pages");
      if (budget.left <= 0) return problem("conversations.members", undefined, "call_cap_reached");
      budget.left -= 1;
      const reply = await get("conversations.members", { channel: channelId, limit: "1000", ...(cursor === "" ? {} : { cursor }) });
      if (reply === undefined) return undefined;
      if (reply.body.ok !== true || !Array.isArray(reply.body.members)) return refused("conversations.members", reply);
      for (const member of reply.body.members) if (typeof member === "string") users.add(member);
      const next = (reply.body.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
      cursor = typeof next === "string" ? next : "";
      if (cursor === "") break;
    }
    if (members.size >= CACHE_CAP) members.delete(members.keys().next().value as string);
    members.set(channelId, { at: input.now(), users });
    return users;
  };
  /** From the cache, from a read already in flight for this channel, or a new read. */
  const channelUsers = (channelId: string, budget: Budget): Promise<Set<string> | undefined> => {
    const cached = members.get(channelId);
    if (cached !== undefined && input.now() - cached.at < cacheMs) return Promise.resolve(cached.users);
    const inFlight = loading.get(channelId);
    if (inFlight !== undefined) return inFlight;
    const read = loadChannel(channelId, budget).finally(() => loading.delete(channelId));
    loading.set(channelId, read);
    return read;
  };

  return {
    async userStatus(userId) {
      if (input.teamId === undefined) return "unavailable";
      const reply = await get("users.info", { user: userId });
      if (reply === undefined) return "unavailable";
      // Only user_not_found is about the person. A deactivated user is ok:true with deleted:true;
      // errors such as account_inactive describe the bot token and must not sign everyone out.
      if (reply.body.ok !== true) {
        if (reply.body.error === "user_not_found") return "gone";
        refused("users.info", reply);
        return "unavailable";
      }
      return inTeam(userOf(reply.body)) ? "active" : "gone";
    },
    async lookupByEmail(email) {
      if (input.teamId === undefined) return "unavailable";
      const reply = await get("users.lookupByEmail", { email });
      if (reply === undefined) return "unavailable";
      if (reply.body.ok !== true) {
        if (reply.body.error === "users_not_found") return "none";
        refused("users.lookupByEmail", reply);
        return "unavailable";
      }
      const user = userOf(reply.body);
      return inTeam(user) && typeof user.id === "string" ? { userId: user.id } : "none";
    },
    async channelMembers(userId, channelIds) {
      if (input.teamId === undefined) return { ok: false, error: "slack_unavailable" };
      const budget: Budget = { left: maxCalls };
      const memberOf: string[] = [];
      for (const channelId of [...new Set(channelIds)].sort()) {
        const users = await channelUsers(channelId, budget);
        if (users === undefined) return { ok: false, error: "slack_unavailable" };
        if (users.has(userId)) memberOf.push(channelId);
      }
      return { ok: true, memberOf };
    },
    async channelInfo(channelIds) {
      if (input.teamId === undefined) return { ok: false, error: "slack_unavailable" };
      const channels: Array<{ channelId: string; name: string; isPrivate: boolean }> = [];
      let callsLeft = maxInfoCalls;
      // Once Slack fails or the budget is spent, only cached names are added: partial names beat none.
      let stopped = false;
      let failed = false;
      for (const channelId of [...new Set(channelIds)].sort()) {
        const cached = info.get(channelId);
        if (cached !== undefined && input.now() - cached.at < cacheMs) {
          channels.push({ channelId, name: cached.name, isPrivate: cached.isPrivate });
          continue;
        }
        if (stopped) continue;
        if (callsLeft <= 0) {
          problem("conversations.info", undefined, "call_cap_reached");
          stopped = true;
          continue;
        }
        callsLeft -= 1;
        const reply = await get("conversations.info", { channel: channelId });
        if (reply === undefined) {
          stopped = failed = true;
          continue;
        }
        const channel = reply.body.channel as { name?: unknown; is_private?: unknown } | undefined;
        if (reply.body.ok !== true || typeof channel?.name !== "string") {
          // A channel Slack no longer knows is left out; any other refusal is about the token.
          if (reply.body.error === "channel_not_found") continue;
          refused("conversations.info", reply);
          stopped = failed = true;
          continue;
        }
        // Fail closed: a channel is public only when Slack says so.
        const entry = { at: input.now(), name: channel.name, isPrivate: channel.is_private !== false };
        if (info.size >= CACHE_CAP) info.delete(info.keys().next().value as string);
        info.set(channelId, entry);
        channels.push({ channelId, name: entry.name, isPrivate: entry.isPrivate });
      }
      if (failed && channels.length === 0) return { ok: false, error: "slack_unavailable" };
      return { ok: true, channels };
    },
  };
}
