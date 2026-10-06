// Spec 025 FR-009, FR-013, FR-014 and FR-016: GET projects, and the project access check the task
// routes use. /v1/dev/* has no API Gateway authorizer (D17): the broker verifies the developer
// access token itself, then checks the environment, the method and the sign-in session on every
// request (R12, R13), so a revoked session stops at once.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  AgentXNameSchema,
  CHANNEL_MEMBERS_MAX_CHANNELS,
  DEVELOPER_TOKEN_AUDIENCE,
  DEVELOPER_WORKSPACES_PER_PROJECT,
  WORKSPACE_PROJECT_INDEX,
  WorkspaceInstanceSchema,
  agentXError,
  developerTaskPolicy,
  workspaceRecordFields,
  type ChannelByNameRequest,
  type ChannelByNameResponse,
  type ChannelInfoRequest,
  type ChannelInfoResponse,
  type ChannelMembersRequest,
  type ChannelMembersResponse,
  type DeveloperProjectsResponse,
  type DeveloperSignInMethod,
  type DeveloperTaskPolicy,
  type DeveloperWorkspace,
  type DeveloperWorkspacesResponse,
  type EndDeveloperSessionsRequest,
  type EndDeveloperSessionsResponse,
  type SlackAuthCheckRequest,
  type SlackAuthCheckResponse,
  type SlackChannelBinding,
  type SlackUserByEmailRequest,
  type SlackUserByEmailResponse,
} from "@agentx/contracts";
import { accessDeniedMessage, resolveDeveloperAccess } from "../developer/access.js";
import { META, endedByAdmin, methodSince, startedBeforeMethodOn, type DeveloperRecord, type SessionRecord } from "../developer/store.js";
import type { DeveloperTaskActions } from "./developer-task-actions.js";
import { getWorkflowFeedbackReview, routeDeveloperTaskRequest, submitWorkflowFeedbackDecision, type DeveloperTaskRouteDependencies } from "./developer-tasks.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import { createFeedbackReviewWeb } from "./feedback-review-web.js";

export interface DeveloperApiConfiguration {
  issuer: string; env: string; methods: { slack: boolean; oidc: boolean }; slackTeamId?: string;
  /** Each method's enabled-since cutoff, epoch seconds (FR-045): a session started before it was ended by a disable. */
  since?: { slack?: number; oidc?: number };
  signInTableName: string;
  channelMembers(request: ChannelMembersRequest): Promise<ChannelMembersResponse>;
  /** R10: bound channels' names and privacy, read by DeveloperIdentity. Optional: without it channels are listed by ID. */
  channelInfo?: (request: ChannelInfoRequest) => Promise<ChannelInfoResponse>;
  /** How long one request waits for channel names in all; the rest stay unnamed. Default 5 seconds. */
  channelInfoDeadlineMs?: number;
  /** Spec 025 A12: FR-012's email lookup, for an admin's Slack link. */
  slackUserByEmail?: (request: SlackUserByEmailRequest) => Promise<SlackUserByEmailResponse>;
  /** Spec 025 A13: the health route's Slack token check. */
  slackAuthCheck?: () => Promise<SlackAuthCheckResponse>;
  /** Spec 025 E9: an admin ends a developer's sign-in sessions, through DeveloperIdentity (the broker only reads the sign-in table). */
  endDeveloperSessions?: (request: EndDeveloperSessionsRequest) => Promise<EndDeveloperSessionsResponse>;
  /** Spec 025 E12: a public channel by its name, through DeveloperIdentity. */
  channelByName?: (request: ChannelByNameRequest) => Promise<ChannelByNameResponse>;
  /** Verifies the Authorization header's developer access token (D17; verify-token.ts) and returns its claims. */
  verifyAccessToken(authorization: string | undefined): Promise<Record<string, unknown>>;
}
export interface DeveloperRouteDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  developer: DeveloperApiConfiguration;
  now: () => number;
  /** The developer task routes' broker actions; without them /v1/dev/tasks* answers NOT_FOUND. */
  tasks?: DeveloperTaskActions;
  /** Reconciles all already-linked PRs using GitHub's current API state before owner decisions. */
  refreshTaskFeedback?(taskId: string): Promise<void>;
}
export interface DeveloperCaller { developerId: string; sessionId: string; amr: DeveloperSignInMethod; name: string; slackUserId?: string; email?: string }

/** What the broker needs from a Lambda invoke; `@aws-sdk/client-lambda`'s InvokeCommand output fits. */
export interface ChannelMembersInvokeResult { FunctionError?: string | undefined; Payload?: Uint8Array | undefined }

/** One structured log line. Only event names, reasons and error names: never payloads or secrets. */
function logDeveloperEvent(entry: Record<string, string>): void {
  console.log(JSON.stringify({ component: "broker", ...entry }));
}
const errorName = (error: unknown) => (error instanceof Error ? error.name : "UnknownError");
const SLACK_UNAVAILABLE = { ok: false, error: "slack_unavailable" } as const;
/** A Slack or DeveloperIdentity error code: the only error text that may reach a log or an answer (R9). */
const SLACK_ERROR_CODE = /^[a-z_]{1,64}$/;
type IdentityRefusal = typeof SLACK_UNAVAILABLE | { ok: false; error: "invalid_request" };

/**
 * One direct invoke of the DeveloperIdentity function, which holds the Slack token (the broker
 * never reads the Slack secret). `readReply` returns the good answer from the decoded reply, or
 * undefined. Every failure fails closed as slack_unavailable with one `<event>_failed` log line;
 * an invalid_request reply is a broker bug, logged as `<event>_invalid_request`. Lines carry only
 * the reason, error name, FunctionError or reply error, never a payload.
 */
async function identityInvoke<T>(
  invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>,
  request: ChannelMembersRequest | ChannelInfoRequest | SlackUserByEmailRequest | SlackAuthCheckRequest | EndDeveloperSessionsRequest | ChannelByNameRequest,
  readReply: (reply: Record<string, unknown>) => T | undefined,
  event: string,
): Promise<T | IdentityRefusal> {
  const failed = (entry: Record<string, string>) => {
    logDeveloperEvent({ event: `${event}_failed`, ...entry });
    return SLACK_UNAVAILABLE;
  };
  let response: ChannelMembersInvokeResult;
  try {
    response = await invoke(Buffer.from(JSON.stringify(request)));
  } catch (error) {
    return failed({ reason: "invoke_error", error: errorName(error) });
  }
  if (response.FunctionError !== undefined) return failed({ reason: "function_error", functionError: response.FunctionError });
  if (response.Payload === undefined) return failed({ reason: "empty_reply" });
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(response.Payload).toString("utf8"));
  } catch {
    return failed({ reason: "unreadable_reply" });
  }
  const reply = typeof decoded === "object" && decoded !== null ? decoded as Record<string, unknown> : {};
  const good = readReply(reply);
  if (good !== undefined) return good;
  if (reply.ok === false && reply.error === "invalid_request") {
    logDeveloperEvent({ event: `${event}_invalid_request`, reason: "the identity function refused the broker's request; this is a broker bug" });
    return { ok: false, error: "invalid_request" };
  }
  // Only a code-shaped reply error (such as token_revoked) is logged; never free text.
  return failed({ reason: "reply_error", error: reply.ok === false && typeof reply.error === "string" && SLACK_ERROR_CODE.test(reply.error) ? reply.error : "malformed_reply" });
}

/** The broker's channel-members check (FR-013) through the DeveloperIdentity function. */
export function channelMembersThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelMembersRequest) => Promise<ChannelMembersResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => (reply.ok === true && Array.isArray(reply.memberOf)
    ? { ok: true as const, memberOf: reply.memberOf.filter((entry): entry is string => typeof entry === "string") }
    : undefined), "developer.channel_members");
}

type ChannelEntry = { channelId: string; name: string; isPrivate: boolean };
const isChannelEntry = (entry: unknown): entry is ChannelEntry => {
  const candidate = entry as Partial<Record<keyof ChannelEntry, unknown>> | null;
  return typeof candidate === "object" && candidate !== null && typeof candidate.channelId === "string" && typeof candidate.name === "string" && typeof candidate.isPrivate === "boolean";
};

/** R10: bound channels' names and privacy through the DeveloperIdentity function; keeps only well-formed entries. */
export function channelInfoThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelInfoRequest) => Promise<ChannelInfoResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => (reply.ok === true && Array.isArray(reply.channels)
    ? { ok: true as const, channels: reply.channels.filter(isChannelEntry).map(({ channelId, name, isPrivate }) => ({ channelId, name, isPrivate })) }
    : undefined), "developer.channel_info");
}

/** A12: who owns a verified email, through DeveloperIdentity; fails closed as slack_unavailable. */
export function slackUserByEmailThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: SlackUserByEmailRequest) => Promise<SlackUserByEmailResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => (reply.ok === true
    ? (typeof reply.userId === "string" ? { ok: true as const, userId: reply.userId } : { ok: true as const })
    : undefined), "developer.slack_user_by_email");
}

/** A13: the bot token's auth.test, through DeveloperIdentity. Slack's refusal code passes through. */
export function slackAuthCheckThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): () => Promise<SlackAuthCheckResponse> {
  return async () => {
    let refusal: string | undefined;
    const answer = await identityInvoke(invoke, { kind: "slack-auth-check" }, (reply) => {
      if (reply.ok === true && typeof reply.teamId === "string") return { ok: true as const, teamId: reply.teamId };
      if (reply.ok === false && typeof reply.error === "string" && SLACK_ERROR_CODE.test(reply.error) && reply.error !== "invalid_request") refusal = reply.error;
      return undefined;
    }, "developer.slack_auth_check");
    if (answer.ok) return answer;
    return { ok: false, error: refusal ?? answer.error };
  };
}

/**
 * E9: ends a developer's sessions through DeveloperIdentity. A not_found reply is an answer (the
 * developer never signed in), not a failure, so it is neither logged as one nor turned into
 * unavailable (C15). Every other failure is unavailable.
 */
export function endDeveloperSessionsThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: EndDeveloperSessionsRequest) => Promise<EndDeveloperSessionsResponse> {
  return async (request) => {
    const answer = await identityInvoke(invoke, request, (reply): EndDeveloperSessionsResponse | undefined => {
      if (reply.ok === true) return { ok: true };
      if (reply.ok === false && reply.error === "not_found") return { ok: false, error: "not_found" };
      return undefined;
    }, "developer.end_sessions");
    if (answer.ok || answer.error === "not_found" || answer.error === "invalid_request") return answer;
    return { ok: false, error: "unavailable" };
  };
}

/** E12 (Q8): a public channel by name through DeveloperIdentity; fails closed as slack_unavailable. */
export function channelByNameThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelByNameRequest) => Promise<ChannelByNameResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => {
    if (reply.ok !== true) return undefined;
    const channel = reply.channel as { channelId?: unknown; name?: unknown } | undefined;
    return typeof channel?.channelId === "string" && typeof channel.name === "string"
      ? { ok: true as const, channel: { channelId: channel.channelId, name: channel.name } }
      : { ok: true as const };
  }, "developer.channel_by_name");
}

/** The broker's copy of each method's enabled-since cutoff (FR-045), from its environment. */
export function developerSinceFromEnvironment(env: NodeJS.ProcessEnv): { slack?: number; oidc?: number } {
  const slack = methodSince(env.DEVELOPER_SIGNIN_SLACK_SINCE);
  const oidc = methodSince(env.DEVELOPER_OIDC_SINCE);
  return { ...(slack === undefined ? {} : { slack }), ...(oidc === undefined ? {} : { oidc }) };
}

/**
 * The sign-in server's public keys, read by invoking the DeveloperIdentity function with its own
 * JWKS route (D17): the broker may not call kms:GetPublicKey, which the key policy keeps to
 * DeveloperIdentity. Any failure throws, and the verifier answers 503 for it.
 */
export function developerKeysThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): () => Promise<unknown[]> {
  const request = { version: "2.0", rawPath: "/v1/auth/.well-known/jwks.json", requestContext: { requestId: "broker-jwks", http: { method: "GET" } } };
  const failed = (reason: string, entry: Record<string, string> = {}) => {
    logDeveloperEvent({ event: "developer.jwks_failed", reason, ...entry });
    return new Error(`the developer sign-in keys could not be read (${reason})`);
  };
  return async () => {
    let response: ChannelMembersInvokeResult;
    try {
      response = await invoke(Buffer.from(JSON.stringify(request)));
    } catch (error) {
      throw failed("invoke_error", { error: errorName(error) });
    }
    if (response.FunctionError !== undefined) throw failed("function_error", { functionError: response.FunctionError });
    if (response.Payload === undefined) throw failed("empty_reply");
    let keys: unknown;
    try {
      const reply = JSON.parse(Buffer.from(response.Payload).toString("utf8")) as { statusCode?: unknown; body?: unknown };
      if (reply.statusCode !== 200 || typeof reply.body !== "string") throw new Error("not 200");
      keys = (JSON.parse(reply.body) as { keys?: unknown }).keys;
    } catch {
      throw failed("unreadable_reply");
    }
    if (!Array.isArray(keys) || keys.length === 0) throw failed("no_keys");
    return keys as unknown[];
  };
}

const SIGN_IN_AGAIN = "your AgentX sign-in has ended; run agentx login <url> again";

export function developerClaims(claims: Record<string, unknown> | undefined, config: DeveloperApiConfiguration): { developerId: string; sessionId: string; amr: DeveloperSignInMethod } {
  if (claims === undefined || claims.iss !== config.issuer || claims.aud !== DEVELOPER_TOKEN_AUDIENCE || claims.env !== config.env) {
    throw agentXError("AUTH_REQUIRED", "this route needs an AgentX developer sign-in; run agentx login <url>");
  }
  if (typeof claims.sub !== "string" || !/^[a-f0-9]{64}$/.test(claims.sub) || typeof claims.sid !== "string" || claims.sid === "") {
    throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  }
  const amr = claims.amr;
  if (amr !== "slack" && amr !== "oidc") throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  if (!config.methods[amr]) {
    throw agentXError("AUTH_REQUIRED", `${amr === "slack" ? "Slack" : "Company"} sign-in is turned off in this environment; sign in another way with agentx login <url>`);
  }
  return { developerId: claims.sub, sessionId: claims.sid, amr };
}

async function getSignIn<T>(deps: DeveloperRouteDependencies, pk: string): Promise<T | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: { pk, sk: META }, ConsistentRead: true })) as { Item?: T };
  return response.Item;
}

export async function authenticateDeveloper(deps: DeveloperRouteDependencies, claims: Record<string, unknown> | undefined): Promise<DeveloperCaller> {
  const token = developerClaims(claims, deps.developer);
  return authenticateSession(deps, token);
}

async function authenticateSession(deps: DeveloperRouteDependencies, token: { developerId: string; sessionId: string; amr: DeveloperSignInMethod }): Promise<DeveloperCaller> {
  const session = await getSignIn<Pick<SessionRecord, "developerId" | "amr" | "endsAt" | "revokedAt" | "startedAt" | "slackUserId">>(deps, `SESSION#${token.sessionId}`);
  if (session === undefined || session.developerId !== token.developerId || session.revokedAt !== undefined || session.endsAt <= Math.floor(deps.now() / 1000)) {
    throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  }
  if (session.amr !== token.amr) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  // The broker may only read the sign-in table (R13), so it refuses; the token endpoint revokes the
  // session at its next refresh.
  if (startedBeforeMethodOn(session.startedAt, deps.developer.since?.[token.amr])) {
    throw agentXError("AUTH_REQUIRED", `your sign-in ended when ${token.amr === "slack" ? "Slack" : "company sign-in"} was turned off; sign in again with agentx login <url>`);
  }
  const developer = await getSignIn<Pick<DeveloperRecord, "displayName" | "slackUserId" | "email" | "revoked" | "sessionsEndedAt">>(deps, `DEVELOPER#${token.developerId}`);
  if (developer === undefined || developer.revoked) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  if (endedByAdmin(session.startedAt, developer.sessionsEndedAt)) {
    // E9: D16's per-request check ends the session at once; the token endpoint revokes it at its next refresh.
    throw agentXError("AUTH_REQUIRED", "an AgentX admin ended your sign-in; run agentx login <url> again");
  }
  return {
    ...token,
    name: developer.displayName,
    ...(developer.slackUserId === undefined ? {} : { slackUserId: developer.slackUserId }),
    ...(developer.email === undefined ? {} : { email: developer.email }),
  };
}

/** Rechecks an opaque browser-cookie session against DeveloperIdentity on every page/API request. */
export async function authenticateDeveloperSessionId(deps: DeveloperRouteDependencies, sessionId: string): Promise<DeveloperCaller> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  const session = await getSignIn<Pick<SessionRecord, "developerId" | "amr" | "reviewExpiresAt">>(deps, `SESSION#${sessionId}`);
  if (session === undefined || (session.amr !== "slack" && session.amr !== "oidc")
    || session.reviewExpiresAt === undefined || session.reviewExpiresAt <= Math.floor(deps.now() / 1000)) {
    throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  }
  return authenticateSession(deps, { developerId: session.developerId, sessionId, amr: session.amr });
}

/** Every item under `pk` with the sort key prefix, following LastEvaluatedKey through each page. */
async function queryAll<T>(deps: DeveloperRouteDependencies, pk: string, prefix: string): Promise<T[]> {
  const items: T[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      ConsistentRead: true,
    })) as { Items?: T[]; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(response.Items ?? []));
    start = response.LastEvaluatedKey;
  } while (start !== undefined);
  return items;
}

/** Channel names are for display only: they never hold the projects list near a timeout. */
const CHANNEL_NAMES_DEADLINE_MS = 5_000;
const REVISION_READS_AT_ONCE = 8;

/** `fn` over every item, at most `limit` at a time, results in the items' order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The latest revision's number and task policy: the only fields read, so only they are fetched. */
async function latestDefinition(deps: DeveloperRouteDependencies, project: string): Promise<{ revision: number; developerTasks?: unknown } | undefined> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `PROJECT#${project}`, ":prefix": "REV#" },
    ProjectionExpression: "#definition.#revision, #definition.#developerTasks",
    ExpressionAttributeNames: { "#definition": "definition", "#revision": "revision", "#developerTasks": "developerTasks" },
    ScanIndexForward: false,
    Limit: 1,
    ConsistentRead: true,
  })) as { Items?: Array<{ definition: { revision: number; developerTasks?: unknown } }> };
  return response.Items?.[0]?.definition;
}

/** Each named project's latest revision and task policy; projects with no revision are left out. */
export async function projectsWithPolicy(deps: DeveloperRouteDependencies, names: readonly string[]): Promise<Map<string, { revision: number; policy: DeveloperTaskPolicy }>> {
  const unique = [...new Set(names)].sort();
  const definitions = await mapLimit(unique, REVISION_READS_AT_ONCE, (name) => latestDefinition(deps, name));
  const found = new Map<string, { revision: number; policy: DeveloperTaskPolicy }>();
  unique.forEach((name, index) => {
    const definition = definitions[index];
    // developerTaskPolicy fails closed: a policy that no longer parses turns tasks and channel access off.
    if (definition !== undefined) found.set(name, { revision: definition.revision, policy: developerTaskPolicy(definition) });
  });
  return found;
}

/** The channel-members check, failing closed (and logged by error name) when it throws. */
function safeChannelMembers(deps: DeveloperRouteDependencies): (request: ChannelMembersRequest) => Promise<ChannelMembersResponse> {
  return async (request) => {
    try {
      return await deps.developer.channelMembers(request);
    } catch (error) {
      logDeveloperEvent({ event: "developer.channel_members_failed", reason: "threw", error: errorName(error) });
      return SLACK_UNAVAILABLE;
    }
  };
}

/**
 * Channel names and privacy, best effort: without them the channels are listed by ID (R10).
 * Privacy comes from DeveloperIdentity's 10-minute cache. The whole lookup has one deadline.
 */
async function channelNames(deps: DeveloperRouteDependencies, channelIds: readonly string[]): Promise<Map<string, { name: string; isPrivate: boolean }>> {
  const names = new Map<string, { name: string; isPrivate: boolean }>();
  const channelInfo = deps.developer.channelInfo;
  if (channelInfo === undefined || channelIds.length === 0) return names;
  const unique = [...new Set(channelIds)].sort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deps.developer.channelInfoDeadlineMs ?? CHANNEL_NAMES_DEADLINE_MS);
  });
  try {
    for (let start = 0; start < unique.length; start += CHANNEL_MEMBERS_MAX_CHANNELS) {
      let answer: ChannelInfoResponse | "deadline";
      try {
        answer = await Promise.race([channelInfo({ kind: "channel-info", channelIds: unique.slice(start, start + CHANNEL_MEMBERS_MAX_CHANNELS) }), expired]);
      } catch (error) {
        logDeveloperEvent({ event: "developer.channel_info_failed", reason: "threw", error: errorName(error) });
        return names;
      }
      if (answer === "deadline") {
        logDeveloperEvent({ event: "developer.channel_info_failed", reason: "deadline" });
        return names;
      }
      if (!answer.ok) return names;
      for (const channel of answer.channels) names.set(channel.channelId, { name: channel.name, isPrivate: channel.isPrivate });
    }
    return names;
  } finally {
    clearTimeout(timer);
  }
}

/** A private channel is flagged by ID only: its name never leaves the control plane (R10). */
const describeChannel = (channelId: string, names: Map<string, { name: string; isPrivate: boolean }>) => {
  const known = names.get(channelId);
  if (known === undefined) return { channelId };
  return known.isPrivate ? { channelId, isPrivate: true } : { channelId, name: known.name, isPrivate: false };
};

/**
 * FR-013: only `developer` rows are grants. A developer ID is built like an admin owner key, so an
 * admin's `administrator` rows can sit under the same key when both sign in through one IdP.
 */
async function grantsOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<string[]> {
  return (await queryAll<{ projectName: string; role?: string }>(deps, `MEMBER#${caller.developerId}`, "PROJECT#"))
    .filter((membership) => membership.role === "developer")
    .map((membership) => membership.projectName);
}

async function bindingsOf(deps: DeveloperRouteDependencies): Promise<SlackChannelBinding[]> {
  return deps.developer.slackTeamId === undefined ? [] : queryAll<SlackChannelBinding>(deps, `SLACK_BINDING#${deps.developer.slackTeamId}`, "CHANNEL#");
}

async function listProjects(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<DeveloperProjectsResponse> {
  const grants = await grantsOf(deps, caller);
  const bindings = await bindingsOf(deps);
  const policies = await projectsWithPolicy(deps, [...grants, ...bindings.map((binding) => binding.projectName)]);
  const access = await resolveDeveloperAccess({
    grants,
    bindings,
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
    // FR-013 with FR-014: a project's own switch decides whether channel members may use it.
    channelMembersMayUse: (project) => policies.get(project)?.policy.channelMembersMayUse === true,
    channelMembers: safeChannelMembers(deps),
  });
  const listed = [...access.projects].filter(([name]) => policies.has(name));
  // Like checkProjectAccess: a caller with no Slack link is never shown channel names.
  const names = caller.slackUserId === undefined ? new Map<string, { name: string; isPrivate: boolean }>() : await channelNames(deps, listed.flatMap(([, entry]) => entry.channels));
  const projects: DeveloperProjectsResponse["projects"] = [];
  for (const [name, entry] of listed) {
    const known = policies.get(name)!;
    projects.push({ name, latestRevision: known.revision, access: entry.access, channels: entry.channels.map((channelId) => describeChannel(channelId, names)), tasks: known.policy });
  }
  return {
    developer: {
      id: caller.developerId, name: caller.name, provider: caller.amr,
      ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
      ...(caller.email === undefined ? {} : { email: caller.email }),
    },
    projects,
    notices: access.slackUnavailable ? ["slack_unavailable"] : [],
  };
}

/**
 * FR-018's first three checks, in order, for one project; the start route calls it (Task 8), and
 * every route must call it before a DeveloperTaskActions member that trusts its caller.
 * PROJECT_NOT_FOUND, then PROJECT_ACCESS_DENIED (naming only public bound channels, R10), or
 * SLACK_UNAVAILABLE when only a channel could have given access and Slack is down, then
 * PROJECT_TASKS_DISABLED.
 */
export async function checkProjectAccess(deps: DeveloperRouteDependencies, caller: DeveloperCaller, project: string): Promise<{ revision: number; policy: DeveloperTaskPolicy; access: "granted" | "channel"; channelIds: string[] }> {
  // A name that is not a project name is never echoed back: it could be long or carry markup.
  if (!AgentXNameSchema.safeParse(project).success) throw agentXError("PROJECT_NOT_FOUND", "that is not a valid AgentX project name");
  const known = (await projectsWithPolicy(deps, [project])).get(project);
  if (known === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist in this AgentX`);
  const grants = (await grantsOf(deps, caller)).filter((name) => name === project);
  const bindings = (await bindingsOf(deps)).filter((binding) => binding.projectName === project);
  const access = await resolveDeveloperAccess({
    grants,
    bindings,
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
    channelMembersMayUse: () => known.policy.channelMembersMayUse,
    channelMembers: safeChannelMembers(deps),
  });
  const entry = access.projects.get(project);
  if (entry === undefined) {
    if (access.slackUnavailable) throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your channel membership; try again, or ask an admin for access");
    // Only a channel that would give access is worth naming, and only a public one (R10).
    const visible = caller.slackUserId === undefined || !known.policy.channelMembersMayUse
      ? []
      : [...(await channelNames(deps, bindings.map((binding) => binding.channelId))).values()].filter((channel) => !channel.isPrivate).map((channel) => channel.name).sort();
    throw agentXError("PROJECT_ACCESS_DENIED", accessDeniedMessage(project, visible));
  }
  if (!known.policy.enabled) throw agentXError("PROJECT_TASKS_DISABLED", `tasks from AI tools are turned off for \`${project}\`; use the project's Slack channel, or ask an admin`);
  return { revision: known.revision, policy: known.policy, access: entry.access, channelIds: bindings.map((binding) => binding.channelId).sort() };
}

/**
 * Spec 041 FR-002: a project's workspaces, newest first, from the sparse byWorkspaceProject index.
 * Only a workspace's own fields are read; the index carries the whole item, so no second get is
 * needed per workspace.
 */
async function projectWorkspaces(deps: DeveloperRouteDependencies, project: string): Promise<DeveloperWorkspace[]> {
  const items: Array<Record<string, unknown>> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      IndexName: WORKSPACE_PROJECT_INDEX.name,
      KeyConditionExpression: "#project = :project",
      ExpressionAttributeNames: { "#project": WORKSPACE_PROJECT_INDEX.partitionKey },
      ExpressionAttributeValues: { ":project": project },
      // Newest first, and never more than one page past the cap: a project with thousands of
      // thread workspaces must not turn one page load into an unbounded scan.
      ScanIndexForward: false,
      Limit: DEVELOPER_WORKSPACES_PER_PROJECT,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(response.Items ?? []));
    start = items.length >= DEVELOPER_WORKSPACES_PER_PROJECT ? undefined : response.LastEvaluatedKey;
  } while (start !== undefined);

  const workspaces: DeveloperWorkspace[] = [];
  for (const item of items.slice(0, DEVELOPER_WORKSPACES_PER_PROJECT)) {
    const parsed = WorkspaceInstanceSchema.safeParse(workspaceRecordFields(item));
    // A record this release cannot read is left out rather than failing the whole listing.
    if (!parsed.success) {
      logDeveloperEvent({ event: "developer.workspace_unreadable", project, reason: parsed.error.issues[0]?.message ?? "invalid" });
      continue;
    }
    const workspace = parsed.data;
    workspaces.push({
      id: workspace.id,
      projectName: workspace.projectName,
      projectRevision: workspace.projectRevision,
      status: workspace.status,
      busy: workspace.activeOperationId !== null,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    });
  }
  return workspaces;
}

/**
 * FR-001: the projects the caller may use, with the workspaces in each of them. The projects come
 * from listProjects itself, so this route applies exactly the same access rules (grants, and channel
 * membership only where the project's developerTasks policy allows it, failing closed).
 */
async function listWorkspaces(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<DeveloperWorkspacesResponse> {
  const listing = await listProjects(deps, caller);
  const workspaces: DeveloperWorkspace[] = [];
  for (const project of listing.projects) workspaces.push(...await projectWorkspaces(deps, project.name));
  // Across projects, still newest first, so the page's list reads as one timeline.
  workspaces.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { ...listing, workspaces };
}

export function developerTaskRouteDependencies(
  deps: DeveloperRouteDependencies,
  caller: DeveloperCaller,
  initialSlackThread?: { teamId: string; channelId: string; threadTs: string },
): DeveloperTaskRouteDependencies {
  return {
    documentClient: deps.documentClient,
    tableName: deps.tableName,
    ...(deps.developer.slackTeamId === undefined ? {} : { slackTeamId: deps.developer.slackTeamId }),
    actions: deps.tasks!,
    ...(deps.refreshTaskFeedback === undefined ? {} : { refreshTaskFeedback: deps.refreshTaskFeedback.bind(deps) }),
    ...(initialSlackThread === undefined ? {} : { initialSlackThread }),
    checkAccess: (project) => checkProjectAccess(deps, caller, project),
    channelMember: async (slackUserId, channelId) => {
      const answer = await safeChannelMembers(deps)({ kind: "channel-members", slackUserId, channelIds: [channelId] });
      if (!answer.ok) throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your membership of that channel; try again shortly");
      return answer.memberOf.includes(channelId);
    },
    projectChannelIds: async (project) => (await bindingsOf(deps)).filter((binding) => binding.projectName === project).map((binding) => binding.channelId).sort(),
    ...(deps.developer.channelInfo === undefined ? {} : {
      boundChannels: async (channelIds: readonly string[]) => {
        const known = await channelNames(deps, channelIds);
        return channelIds.map((channelId) => {
          const channel = known.get(channelId);
          return channel === undefined ? { channelId } : { channelId, name: channel.name, isPrivate: channel.isPrivate };
        });
      },
    }),
    now: deps.now,
  };
}

export async function routeDeveloperRequest(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  if (url.pathname.startsWith("/review/")) {
    if (deps.tasks === undefined) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
    const web = createFeedbackReviewWeb({
      origin: new URL(deps.developer.issuer).origin,
      authenticateSession: async (sessionId) => {
        try { return await authenticateDeveloperSessionId(deps, sessionId); }
        catch { return undefined; }
      },
      getWorkflowFeedbackReview: (caller, taskId) => getWorkflowFeedbackReview(developerTaskRouteDependencies(deps, caller), caller, taskId),
      submitWorkflowFeedbackDecision: (caller, taskId, input) => submitWorkflowFeedbackDecision(developerTaskRouteDependencies(deps, caller), caller, taskId, input),
      now: deps.now,
    });
    return web(request, url);
  }
  // Never request.jwtClaims: no API Gateway authorizer runs on /v1/dev/* (D17).
  const caller = await authenticateDeveloper(deps, await deps.developer.verifyAccessToken(request.headers.authorization));
  if (request.method === "GET" && url.pathname === "/v1/dev/projects") return listProjects(deps, caller);
  if (request.method === "GET" && url.pathname === "/v1/dev/workspaces") return listWorkspaces(deps, caller);
  if (url.pathname === "/v1/dev/tasks" || url.pathname.startsWith("/v1/dev/tasks/")) {
    if (deps.tasks === undefined) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
    return routeDeveloperTaskRequest(developerTaskRouteDependencies(deps, caller), caller, request, url);
  }
  throw agentXError("NOT_FOUND", "route not found");
}
