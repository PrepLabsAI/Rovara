// Spec 025 FR-009 and FR-016 (GET projects only in 25a). /v1/dev/* has no API Gateway authorizer
// (D17): the broker verifies the developer access token itself, then checks the environment, the
// method and the sign-in session on every request (R12, R13), so a revoked session stops at once.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  DEVELOPER_TOKEN_AUDIENCE,
  agentXError,
  type ChannelMembersRequest,
  type ChannelMembersResponse,
  type DeveloperProjectsResponse,
  type DeveloperSignInMethod,
  type SlackChannelBinding,
} from "@agentx/contracts";
import { resolveDeveloperAccess } from "../developer/access.js";
import { META, methodSince, startedBeforeMethodOn, type DeveloperRecord, type SessionRecord } from "../developer/store.js";
import type { AdaptedHttpRequest } from "./lambda.js";

export interface DeveloperApiConfiguration {
  issuer: string; env: string; methods: { slack: boolean; oidc: boolean }; slackTeamId?: string;
  /** Each method's enabled-since cutoff, epoch seconds (FR-045): a session started before it was ended by a disable. */
  since?: { slack?: number; oidc?: number };
  signInTableName: string;
  channelMembers(request: ChannelMembersRequest): Promise<ChannelMembersResponse>;
  /** Verifies the Authorization header's developer access token (D17; verify-token.ts) and returns its claims. */
  verifyAccessToken(authorization: string | undefined): Promise<Record<string, unknown>>;
}
export interface DeveloperRouteDependencies { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; developer: DeveloperApiConfiguration; now: () => number }
export interface DeveloperCaller { developerId: string; sessionId: string; amr: DeveloperSignInMethod; name: string; slackUserId?: string; email?: string }

/** What the broker needs from a Lambda invoke; `@aws-sdk/client-lambda`'s InvokeCommand output fits. */
export interface ChannelMembersInvokeResult { FunctionError?: string | undefined; Payload?: Uint8Array | undefined }

/** One structured log line. Only event names, reasons and error names: never payloads or secrets. */
function logDeveloperEvent(entry: Record<string, string>): void {
  console.log(JSON.stringify({ component: "broker", ...entry }));
}
const errorName = (error: unknown) => (error instanceof Error ? error.name : "UnknownError");
const SLACK_UNAVAILABLE: ChannelMembersResponse = { ok: false, error: "slack_unavailable" };

/**
 * The broker's channel-members check: a direct invoke of the DeveloperIdentity function, which
 * holds the Slack token (the broker never reads the Slack secret). Every failure fails closed and
 * is logged by its error name, FunctionError or reply error, never by payload.
 */
export function channelMembersThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelMembersRequest) => Promise<ChannelMembersResponse> {
  const failed = (entry: Record<string, string>) => {
    logDeveloperEvent({ event: "developer.channel_members_failed", ...entry });
    return SLACK_UNAVAILABLE;
  };
  return async (request) => {
    let response: ChannelMembersInvokeResult;
    try {
      response = await invoke(Buffer.from(JSON.stringify(request)));
    } catch (error) {
      return failed({ reason: "invoke_error", error: errorName(error) });
    }
    if (response.FunctionError !== undefined) return failed({ reason: "function_error", functionError: response.FunctionError });
    if (response.Payload === undefined) return failed({ reason: "empty_reply" });
    let reply: { ok?: unknown; memberOf?: unknown; error?: unknown };
    try {
      reply = JSON.parse(Buffer.from(response.Payload).toString("utf8")) as typeof reply;
    } catch {
      return failed({ reason: "unreadable_reply" });
    }
    if (reply.ok === true && Array.isArray(reply.memberOf)) {
      return { ok: true, memberOf: reply.memberOf.filter((entry): entry is string => typeof entry === "string") };
    }
    if (reply.ok === false && reply.error === "invalid_request") {
      logDeveloperEvent({ event: "developer.channel_members_invalid_request", reason: "the identity function refused the broker's request; this is a broker bug" });
      return { ok: false, error: "invalid_request" };
    }
    return failed({ reason: "reply_error", error: reply.ok === false && reply.error === "slack_unavailable" ? "slack_unavailable" : "malformed_reply" });
  };
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
  const session = await getSignIn<Pick<SessionRecord, "developerId" | "endsAt" | "revokedAt" | "startedAt">>(deps, `SESSION#${token.sessionId}`);
  if (session === undefined || session.developerId !== token.developerId || session.revokedAt !== undefined || session.endsAt <= Math.floor(deps.now() / 1000)) {
    throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  }
  // The broker may only read the sign-in table (R13), so it refuses; the token endpoint revokes the
  // session at its next refresh.
  if (startedBeforeMethodOn(session.startedAt, deps.developer.since?.[token.amr])) {
    throw agentXError("AUTH_REQUIRED", `your sign-in ended when ${token.amr === "slack" ? "Slack" : "company sign-in"} was turned off; sign in again with agentx login <url>`);
  }
  const developer = await getSignIn<Pick<DeveloperRecord, "displayName" | "slackUserId" | "email" | "revoked">>(deps, `DEVELOPER#${token.developerId}`);
  if (developer === undefined || developer.revoked) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return {
    ...token,
    name: developer.displayName,
    ...(developer.slackUserId === undefined ? {} : { slackUserId: developer.slackUserId }),
    ...(developer.email === undefined ? {} : { email: developer.email }),
  };
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

async function latestRevision(deps: DeveloperRouteDependencies, project: string): Promise<number | undefined> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `PROJECT#${project}`, ":prefix": "REV#" },
    ScanIndexForward: false,
    Limit: 1,
    ConsistentRead: true,
  })) as { Items?: Array<{ definition: { revision: number } }> };
  return response.Items?.[0]?.definition.revision;
}

async function listProjects(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<DeveloperProjectsResponse> {
  // FR-013: only `developer` rows are grants. A developer ID is built like an admin owner key, so an
  // admin's `administrator` rows can sit under the same key when both sign in through one IdP.
  const grants = (await queryAll<{ projectName: string; role?: string }>(deps, `MEMBER#${caller.developerId}`, "PROJECT#"))
    .filter((membership) => membership.role === "developer")
    .map((membership) => membership.projectName);
  const bindings = deps.developer.slackTeamId === undefined ? [] : await queryAll<SlackChannelBinding>(deps, `SLACK_BINDING#${deps.developer.slackTeamId}`, "CHANNEL#");
  const access = await resolveDeveloperAccess({
    grants,
    bindings,
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
    channelMembersMayUse: () => true, // R16: phase 25b reads the revision's developerTasks.channelMembersMayUse
    channelMembers: async (request) => {
      try {
        return await deps.developer.channelMembers(request);
      } catch (error) {
        logDeveloperEvent({ event: "developer.channel_members_failed", reason: "threw", error: errorName(error) });
        return SLACK_UNAVAILABLE;
      }
    },
  });
  const projects: DeveloperProjectsResponse["projects"] = [];
  for (const [name, entry] of access.projects) {
    const revision = await latestRevision(deps, name);
    if (revision === undefined) continue;
    projects.push({ name, latestRevision: revision, access: entry.access, channels: entry.channels.map((channelId) => ({ channelId })) });
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

export async function routeDeveloperRequest(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  // Never request.jwtClaims: no API Gateway authorizer runs on /v1/dev/* (D17).
  const caller = await authenticateDeveloper(deps, await deps.developer.verifyAccessToken(request.headers.authorization));
  if (request.method === "GET" && url.pathname === "/v1/dev/projects") return listProjects(deps, caller);
  throw agentXError("NOT_FOUND", "route not found");
}
