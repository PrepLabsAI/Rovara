// Spec 025 FR-007, FR-012 and FR-013 with the bot token. Every failure to reach Slack is
// "unavailable": the caller fails closed for access and keeps sessions for refreshes (R18).
import type { ChannelMembersResponse } from "@agentx/contracts";

export type SlackUserStatus = "active" | "gone" | "unavailable";
export interface SlackDirectory {
  userStatus(userId: string): Promise<SlackUserStatus>;
  lookupByEmail(email: string): Promise<{ userId: string } | "none" | "unavailable">;
  channelMembers(userId: string, channelIds: readonly string[]): Promise<ChannelMembersResponse>;
}

export const CHANNEL_MEMBERS_CACHE_MS = 600_000;
const CACHE_CAP = 500;
const TIMEOUT_MS = 5_000;

interface SlackUser { id?: string; team_id?: string; deleted?: boolean; is_bot?: boolean; enterprise_user?: { teams?: string[] } }

export function slackDirectory(input: {
  teamId: string | undefined; botToken: () => Promise<string>; fetch: typeof fetch; now: () => number; cacheMs?: number; maxPages?: number;
}): SlackDirectory {
  const cacheMs = input.cacheMs ?? CHANNEL_MEMBERS_CACHE_MS;
  const maxPages = input.maxPages ?? 50;
  const members = new Map<string, { at: number; users: Set<string> }>();

  const get = async (method: string, query: Record<string, string>): Promise<Record<string, unknown> | undefined> => {
    try {
      const url = new URL(`https://slack.com/api/${method}`);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      const response = await input.fetch(url, { headers: { authorization: `Bearer ${await input.botToken()}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (response.status === 429 || response.status >= 500) return undefined;
      return await response.json() as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };
  const inTeam = (user: SlackUser) =>
    user.deleted !== true && user.is_bot === false && (user.team_id === input.teamId || (user.enterprise_user?.teams ?? []).includes(input.teamId ?? ""));
  const userOf = (body: Record<string, unknown>): SlackUser => (typeof body.user === "object" && body.user !== null ? body.user : {});

  return {
    async userStatus(userId) {
      if (input.teamId === undefined) return "unavailable";
      const body = await get("users.info", { user: userId });
      if (body === undefined) return "unavailable";
      if (body.ok !== true) return body.error === "user_not_found" || body.error === "account_inactive" ? "gone" : "unavailable";
      return inTeam(userOf(body)) ? "active" : "gone";
    },
    async lookupByEmail(email) {
      if (input.teamId === undefined) return "unavailable";
      const body = await get("users.lookupByEmail", { email });
      if (body === undefined) return "unavailable";
      if (body.ok !== true) return body.error === "users_not_found" ? "none" : "unavailable";
      const user = userOf(body);
      return inTeam(user) && typeof user.id === "string" ? { userId: user.id } : "none";
    },
    async channelMembers(userId, channelIds) {
      if (input.teamId === undefined) return { ok: false, error: "slack_unavailable" };
      const memberOf: string[] = [];
      for (const channelId of [...new Set(channelIds)].sort()) {
        let entry = members.get(channelId);
        if (entry === undefined || input.now() - entry.at >= cacheMs) {
          const users = new Set<string>();
          let cursor = "";
          for (let page = 0; ; page += 1) {
            if (page >= maxPages) return { ok: false, error: "slack_unavailable" };
            const body = await get("conversations.members", { channel: channelId, limit: "1000", ...(cursor === "" ? {} : { cursor }) });
            if (body === undefined || body.ok !== true || !Array.isArray(body.members)) return { ok: false, error: "slack_unavailable" };
            for (const member of body.members) if (typeof member === "string") users.add(member);
            const next = (body.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
            cursor = typeof next === "string" ? next : "";
            if (cursor === "") break;
          }
          if (members.size >= CACHE_CAP) members.delete(members.keys().next().value as string);
          entry = { at: input.now(), users };
          members.set(channelId, entry);
        }
        if (entry.users.has(userId)) memberOf.push(channelId);
      }
      return { ok: true, memberOf };
    },
  };
}
