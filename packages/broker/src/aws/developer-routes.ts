// Spec 025 FR-009 and FR-016 (GET projects only in 25a). API Gateway's developer JWT authorizer
// has already verified the token; the broker checks issuer, audience, method and the sign-in
// session again on every request (R12, R13), so a revoked session stops at once.
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
import type { DeveloperRecord, SessionRecord } from "../developer/store.js";
import type { AdaptedHttpRequest } from "./lambda.js";

export interface DeveloperApiConfiguration {
  issuer: string; env: string; methods: { slack: boolean; oidc: boolean }; slackTeamId?: string;
  signInTableName: string;
  channelMembers(request: ChannelMembersRequest): Promise<ChannelMembersResponse>;
}
export interface DeveloperRouteDependencies { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; developer: DeveloperApiConfiguration; now: () => number }
export interface DeveloperCaller { developerId: string; sessionId: string; amr: DeveloperSignInMethod; name: string; slackUserId?: string; email?: string }

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
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: { pk, sk: "META" }, ConsistentRead: true })) as { Item?: T };
  return response.Item;
}

export async function authenticateDeveloper(deps: DeveloperRouteDependencies, claims: Record<string, unknown> | undefined): Promise<DeveloperCaller> {
  const token = developerClaims(claims, deps.developer);
  const session = await getSignIn<Pick<SessionRecord, "developerId" | "endsAt" | "revokedAt">>(deps, `SESSION#${token.sessionId}`);
  if (session === undefined || session.developerId !== token.developerId || session.revokedAt !== undefined || session.endsAt <= Math.floor(deps.now() / 1000)) {
    throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
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

async function queryState<T>(deps: DeveloperRouteDependencies, pk: string, prefix: string, options: { newestFirst?: boolean; limit?: number } = {}): Promise<T[]> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
    ...(options.newestFirst ? { ScanIndexForward: false } : {}),
    ...(options.limit === undefined ? {} : { Limit: options.limit }),
    ConsistentRead: true,
  })) as { Items?: T[] };
  return response.Items ?? [];
}

async function listProjects(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<DeveloperProjectsResponse> {
  const grants = (await queryState<{ projectName: string }>(deps, `MEMBER#${caller.developerId}`, "PROJECT#")).map((grant) => grant.projectName);
  const bindings = deps.developer.slackTeamId === undefined ? [] : await queryState<SlackChannelBinding>(deps, `SLACK_BINDING#${deps.developer.slackTeamId}`, "CHANNEL#");
  const access = await resolveDeveloperAccess({
    grants,
    bindings,
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
    channelMembersMayUse: () => true, // R16: phase 25b reads the revision's developerTasks.channelMembersMayUse
    channelMembers: (request) => deps.developer.channelMembers(request),
  });
  const projects: DeveloperProjectsResponse["projects"] = [];
  for (const [name, entry] of access.projects) {
    const [latest] = await queryState<{ definition: { revision: number } }>(deps, `PROJECT#${name}`, "REV#", { newestFirst: true, limit: 1 });
    if (latest === undefined) continue;
    projects.push({ name, latestRevision: latest.definition.revision, access: entry.access, channels: entry.channels.map((channelId) => ({ channelId })) });
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
  const caller = await authenticateDeveloper(deps, request.jwtClaims);
  if (request.method === "GET" && url.pathname === "/v1/dev/projects") return listProjects(deps, caller);
  throw agentXError("NOT_FOUND", "route not found");
}
