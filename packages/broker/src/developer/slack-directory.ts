// Spec 025 FR-007, FR-012 and FR-013 with the bot token. Every failure to reach Slack is
// "unavailable": the caller fails closed for access and keeps sessions for refreshes (R18).
import {
  CHANNEL_MEMBERS_MAX_CHANNELS,
  SlackTeamIdSchema,
  SlackUserIdSchema,
  cleanDisplayName,
  redactAndCap,
  type ChannelByNameResponse,
  type ChannelInfoResponse,
  type ChannelMembersResponse,
  type SlackAuthCheckResponse,
  type TaskPersonProofResponse,
  type TaskPersonProofRequest,
  type TaskChannelPeopleResponse,
  type TaskPeopleDisplayReadRequest,
  type TaskPeopleDisplayReadResponse,
} from "@agentx/contracts";

export type SlackUserStatus = "active" | "gone" | "unavailable";
export interface SlackDirectory {
  userStatus(userId: string): Promise<SlackUserStatus>;
  lookupByEmail(email: string): Promise<{ userId: string } | "none" | "unavailable">;
  channelMembers(userId: string, channelIds: readonly string[]): Promise<ChannelMembersResponse>;
  /** A fresh users.info and complete membership read that never reuses display caches or reads. */
  taskPersonProof(userId: string, channelIds: readonly string[]): Promise<TaskPersonProofResponse>;
  /** Fresh dispatch-only proof with an endpoint-supplied deadline and explicit Slack call meter. */
  taskDispatchPersonProof(request: TaskPersonProofRequest, admission: { deadlineAt: number; slackCallsLimit: number; abortSignal?: AbortSignal }): Promise<{ result: TaskPersonProofResponse; slackCallsUsed: number }>;
  /** Complete, fresh and bounded identities from the named channels; no display cache or in-flight read is reused. */
  taskChannelPeople(channelIds: readonly string[]): Promise<TaskChannelPeopleResponse>;
  /** Request-scoped, metered Task People display read. Old proof/list methods remain unchanged. */
  taskPeopleDisplayRead(request: TaskPeopleDisplayReadRequest): Promise<TaskPeopleDisplayReadResponse>;
  /**
   * R10: each channel's name and privacy, cached like members (so a channel made private shows as
   * public for up to 10 minutes). A channel Slack does not know is left out; so are channels past
   * the per-request call budget or after Slack fails midway, which the caller lists by ID.
   */
  channelInfo(channelIds: readonly string[]): Promise<ChannelInfoResponse>;
  /** A13: whether the bot token works, with the team Slack says it belongs to. Never the token. */
  authTest(): Promise<SlackAuthCheckResponse>;
  /** E12 (Q8): a public channel of the team by its exact name, or none. A private channel is never found by name. */
  channelByName(name: string): Promise<ChannelByNameResponse>;
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
/** Pages of 200 one channelByName request reads before it answers "no such channel". */
export const CHANNEL_BY_NAME_MAX_PAGES = 10;
/** Matched to the contract's batch: every channel of a full cold batch, twice (a second page each). */
const MAX_CALLS_PER_REQUEST = 2 * CHANNEL_MEMBERS_MAX_CHANNELS;

interface SlackUser {
  id?: unknown;
  team_id?: unknown;
  deleted?: unknown;
  is_bot?: unknown;
  is_stranger?: unknown;
  name?: unknown;
  real_name?: unknown;
  profile?: { display_name?: unknown; real_name?: unknown };
  enterprise_user?: { teams?: unknown };
}
type Reply = { status: number; body: Record<string, unknown> };
type Budget = { left: number };
type DisplayFetchAdmission = { readonly deadlineAt: number; readonly slackCallsLimit: number; readonly abortSignal?: AbortSignal; slackCallsUsed: number };

function withAbortSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  const abortError = () => signal.reason instanceof Error ? signal.reason : new Error("deadline reached");
  if (signal.aborted) return Promise.reject(new Error("deadline reached"));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(abortError()); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error("credential lookup failed"));
    });
  });
}

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
  const get = async (method: string, query: Record<string, string>, timeoutMs = TIMEOUT_MS, admission?: DisplayFetchAdmission): Promise<Reply | undefined> => {
    let token: string;
    try {
      token = await withAbortSignal(input.botToken(), admission?.abortSignal);
    } catch {
      return problem(method, undefined, "bot_token_unavailable");
    }
    if (admission !== undefined) {
      if (input.now() >= admission.deadlineAt) return problem(method, undefined, "deadline_reached");
      if (admission.slackCallsUsed >= admission.slackCallsLimit) return problem(method, undefined, "call_cap_reached");
      admission.slackCallsUsed += 1;
      timeoutMs = Math.min(timeoutMs, admission.deadlineAt - input.now());
    }
    let response: Response;
    try {
      const url = new URL(`https://slack.com/api/${method}`);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.min(TIMEOUT_MS, timeoutMs)));
      const signal = admission?.abortSignal === undefined ? timeoutSignal : AbortSignal.any([admission.abortSignal, timeoutSignal]);
      response = await input.fetch(url, { headers: { authorization: `Bearer ${token}` }, signal });
    } catch {
      return problem(method, undefined, "unreachable");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (admission !== undefined && input.now() >= admission.deadlineAt) return problem(method, response.status, "deadline_reached");
    const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : undefined;
    if (response.status === 429 || response.status >= 500 || record === undefined) {
      return problem(method, response.status, errorCode(record?.error) ?? `http_${response.status}`);
    }
    return { status: response.status, body: record };
  };
  /** A reply Slack refused for a reason that says nothing about the person: report it, unavailable. */
  const refused = (method: string, reply: Reply): undefined => problem(method, reply.status, errorCode(reply.body.error) ?? "no_error_code");

  const enterpriseTeams = (user: SlackUser): string[] => Array.isArray(user.enterprise_user?.teams)
    ? user.enterprise_user.teams.filter((team): team is string => typeof team === "string")
    : [];
  const inTeam = (user: SlackUser) =>
    user.deleted !== true && user.is_bot === false && (user.team_id === input.teamId || enterpriseTeams(user).includes(input.teamId ?? ""));
  const taskPersonEligibility = (user: SlackUser): "eligible" | "ineligible" | "unknown" => {
    const primaryTeam = SlackTeamIdSchema.safeParse(user.team_id);
    if (!primaryTeam.success || typeof user.is_bot !== "boolean"
      || (user.deleted !== undefined && typeof user.deleted !== "boolean")
      || (user.is_stranger !== undefined && typeof user.is_stranger !== "boolean")) return "unknown";

    const linkedTeams: string[] = [];
    if (user.enterprise_user !== undefined) {
      const enterpriseUser = user.enterprise_user;
      if (typeof enterpriseUser !== "object" || enterpriseUser === null || Array.isArray(enterpriseUser)
        || !Array.isArray(enterpriseUser.teams)) return "unknown";
      for (const team of enterpriseUser.teams) {
        const parsedTeam = SlackTeamIdSchema.safeParse(team);
        if (!parsedTeam.success) return "unknown";
        linkedTeams.push(parsedTeam.data);
      }
    }

    if (user.deleted === true || user.is_bot || user.is_stranger === true) return "ineligible";
    return primaryTeam.data === input.teamId || linkedTeams.includes(input.teamId ?? "") ? "eligible" : "ineligible";
  };
  const userOf = (body: Record<string, unknown>): SlackUser => (typeof body.user === "object" && body.user !== null ? body.user : {});

  const proofName = (user: SlackUser, fallback: string): string => {
    const raw = [user.profile?.display_name, user.profile?.real_name, user.real_name, user.name]
      .find((value): value is string => typeof value === "string" && value.trim() !== "") ?? fallback;
    return cleanDisplayName(redactAndCap(raw, 80).text) ?? fallback;
  };

  const freshChannelUsers = async (channelId: string, budget: Budget, deadlineAt?: number, admission?: DisplayFetchAdmission): Promise<Set<string> | undefined> => {
    const users = new Set<string>();
    let cursor = "";
    for (let page = 0; ; page += 1) {
      if (page >= maxPages) return problem("conversations.members", undefined, "too_many_pages");
      if (admission === undefined && budget.left <= 0) return problem("conversations.members", undefined, "call_cap_reached");
      if (deadlineAt !== undefined && input.now() >= deadlineAt) return problem("conversations.members", undefined, "deadline_reached");
      if (admission === undefined) budget.left -= 1;
      const reply = await get("conversations.members", { channel: channelId, limit: "1000", ...(cursor === "" ? {} : { cursor }) },
        deadlineAt === undefined ? TIMEOUT_MS : deadlineAt - input.now(), admission);
      if (reply === undefined) return undefined;
      if (reply.body.ok !== true || !Array.isArray(reply.body.members)) return refused("conversations.members", reply);
      for (const member of reply.body.members) {
        const parsed = SlackUserIdSchema.safeParse(member);
        if (!parsed.success) return problem("conversations.members", reply.status, "malformed_member");
        users.add(parsed.data);
      }
      const metadata = reply.body.response_metadata;
      if (metadata !== undefined && (typeof metadata !== "object" || metadata === null)) return problem("conversations.members", reply.status, "malformed_cursor");
      const next = (metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
      if (next !== undefined && typeof next !== "string") return problem("conversations.members", reply.status, "malformed_cursor");
      cursor = next ?? "";
      if (cursor === "") return users;
    }
  };

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

  const taskPersonProof = async (
    userId: string,
    channelIds: readonly string[],
    admission?: DisplayFetchAdmission,
  ): Promise<TaskPersonProofResponse> => {
    if (input.teamId === undefined) return { ok: false, error: "slack_unavailable" };
    const budget: Budget = { left: admission === undefined ? maxCalls : Number.MAX_SAFE_INTEGER };
    if (admission === undefined) {
      if (budget.left <= 0) return { ok: false, error: "slack_unavailable" };
      budget.left -= 1;
    }
    const userReply = await get("users.info", { user: userId }, TIMEOUT_MS, admission);
    if (userReply === undefined) return { ok: false, error: "slack_unavailable" };
    if (userReply.body.ok !== true) {
      if (userReply.body.error === "user_not_found") return { ok: false, error: "ineligible" };
      refused("users.info", userReply);
      return { ok: false, error: "slack_unavailable" };
    }
    const user = userOf(userReply.body);
    const parsedId = SlackUserIdSchema.safeParse(user.id);
    if (!parsedId.success || parsedId.data !== userId) {
      return { ok: false, error: "slack_unavailable" };
    }
    const eligibility = taskPersonEligibility(user);
    if (eligibility === "unknown") return { ok: false, error: "slack_unavailable" };
    if (eligibility === "ineligible") return { ok: false, error: "ineligible" };
    const memberOf: string[] = [];
    for (const channelId of [...new Set(channelIds)].sort()) {
      const users = await freshChannelUsers(channelId, budget, admission?.deadlineAt, admission);
      if (users === undefined) return { ok: false, error: "slack_unavailable" };
      if (users.has(userId)) memberOf.push(channelId);
    }
    return { ok: true, user: { id: parsedId.data, teamId: input.teamId, name: proofName(user, parsedId.data) }, memberOf };
  };

  const taskChannelPeople = async (
    channelIds: readonly string[],
    options?: { admission: DisplayFetchAdmission; remainingNewIdentities: number; knownNativeSlackUserIds: readonly string[] },
  ): Promise<TaskChannelPeopleResponse> => {
    if (input.teamId === undefined) return { ok: false, error: "slack_unavailable" };
    const budget: Budget = { left: options === undefined ? 100 : Number.MAX_SAFE_INTEGER };
    const deadlineAt = options?.admission.deadlineAt ?? input.now() + 20_000;
    const membership = new Map<string, string[]>();
    for (const channelId of [...new Set(channelIds)].sort()) {
      const users = await freshChannelUsers(channelId, budget, deadlineAt, options?.admission);
      if (users === undefined) return { ok: false, error: "slack_unavailable" };
      for (const userId of users) {
        const channels = membership.get(userId) ?? [];
        channels.push(channelId);
        membership.set(userId, channels);
      }
    }
    const knownNative = new Set(options?.knownNativeSlackUserIds ?? []);
    const newIdentities = [...membership.keys()].filter((userId) => !knownNative.has(userId)).length;
    if (options === undefined ? membership.size > 100 : newIdentities > options.remainingNewIdentities) {
      return { ok: false, error: "capacity_exceeded" };
    }
    const users: Array<{ id: string; teamId: string; name: string; memberOf: string[] }> = [];
    for (const userId of [...membership.keys()].sort()) {
      if (options === undefined) {
        if (budget.left <= 0) return { ok: false, error: "capacity_exceeded" };
        budget.left -= 1;
      }
      if (input.now() >= deadlineAt) return { ok: false, error: "slack_unavailable" };
      const reply = await get("users.info", { user: userId }, deadlineAt - input.now(), options?.admission);
      if (reply === undefined) return { ok: false, error: "slack_unavailable" };
      if (input.now() >= deadlineAt) return { ok: false, error: "slack_unavailable" };
      if (reply.body.ok !== true) {
        if (reply.body.error === "user_not_found") continue;
        refused("users.info", reply);
        return { ok: false, error: "slack_unavailable" };
      }
      const user = userOf(reply.body);
      const parsedId = SlackUserIdSchema.safeParse(user.id);
      if (!parsedId.success || parsedId.data !== userId) return { ok: false, error: "slack_unavailable" };
      const eligibility = taskPersonEligibility(user);
      if (eligibility === "unknown") return { ok: false, error: "slack_unavailable" };
      if (eligibility === "ineligible") continue;
      users.push({ id: parsedId.data, teamId: input.teamId, name: proofName(user, parsedId.data), memberOf: membership.get(userId)! });
    }
    return { ok: true, users };
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
    async taskPersonProof(userId, channelIds) {
      return taskPersonProof(userId, channelIds);
    },
    async taskDispatchPersonProof(request, limits) {
      const admission: DisplayFetchAdmission = {
        deadlineAt: Math.min(limits.deadlineAt, input.now() + 6_000),
        slackCallsLimit: Math.min(limits.slackCallsLimit, 100),
      ...(limits.abortSignal === undefined ? {} : { abortSignal: limits.abortSignal }),
        slackCallsUsed: 0,
      };
      const result = await taskPersonProof(request.slackUserId, request.channelIds, admission);
      return { result, slackCallsUsed: admission.slackCallsUsed };
    },
    async taskChannelPeople(channelIds) {
      return taskChannelPeople(channelIds);
    },
    async taskPeopleDisplayRead(request) {
      const admission: DisplayFetchAdmission = {
        deadlineAt: Math.min(request.admission.deadlineAt, input.now() + 20_000),
        slackCallsLimit: request.admission.slackCallsLimit,
        slackCallsUsed: 0,
      };
      const result = request.operation === "proof"
        ? await taskPersonProof(request.request.slackUserId, request.request.channelIds, admission)
        : await taskChannelPeople(request.request.channelIds, {
          admission, remainingNewIdentities: request.remainingNewIdentities, knownNativeSlackUserIds: request.knownNativeSlackUserIds,
        });
      return { operation: request.operation, admission: { version: 1, slackCallsUsed: admission.slackCallsUsed }, result } as TaskPeopleDisplayReadResponse;
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
    async authTest() {
      const reply = await get("auth.test", {});
      if (reply === undefined) return { ok: false, error: "slack_unavailable" };
      if (reply.body.ok !== true || typeof reply.body.team_id !== "string") {
        refused("auth.test", reply);
        // Only an error that is already code-shaped passes: rejected, not stripped (R9).
        const error = reply.body.error;
        return { ok: false, error: typeof error === "string" && /^[a-z_]{1,64}$/.test(error) ? error : "no_error_code" };
      }
      // The team is reported, not checked against input.teamId, on purpose: the health route compares it.
      return { ok: true, teamId: reply.body.team_id };
    },
    async channelByName(name) {
      if (input.teamId === undefined) return { ok: false, error: "slack_unavailable" };
      let cursor = "";
      // E12: public channels only, at most 10 pages of 200; a private channel is given by ID.
      for (let page = 0; page < CHANNEL_BY_NAME_MAX_PAGES; page += 1) {
        const reply = await get("conversations.list", { types: "public_channel", exclude_archived: "true", limit: "200", ...(cursor === "" ? {} : { cursor }) });
        if (reply === undefined) return { ok: false, error: "slack_unavailable" };
        if (reply.body.ok !== true || !Array.isArray(reply.body.channels)) {
          refused("conversations.list", reply);
          return { ok: false, error: "slack_unavailable" };
        }
        for (const channel of reply.body.channels as Array<{ id?: unknown; name?: unknown; is_private?: unknown }>) {
          // Fail closed (Q8): a channel is found only when Slack says it is public.
          if (channel.name === name && typeof channel.id === "string" && channel.is_private === false) return { ok: true, channel: { channelId: channel.id, name } };
        }
        const next = (reply.body.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
        cursor = typeof next === "string" ? next : "";
        if (cursor === "") break;
      }
      return { ok: true };
    },
  };
}
