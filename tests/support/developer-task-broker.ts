// A hosted broker with developer sign-in for developer task tests: the Slack harness's fake table,
// the payments project bound to the test channel, two signed-in developers, and worker callbacks.
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { sharedTaskKey, type ChannelInfoRequest, type ChannelInfoResponse, type ChannelMembersRequest, type ChannelMembersResponse } from "@agentx/contracts";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import type { DeveloperTaskActions } from "../../packages/broker/src/aws/developer-task-actions.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { localSigner } from "./developer-fakes.js";
import type { FakeDynamoDb } from "./fake-dynamodb.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, createBroker, loadSlackBroker, registerSlackProject, type Handler } from "./slack-broker.js";

export const DEV_ISSUER = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth";
export interface Developer { developerId: string; name: string; provider: "slack" | "oidc"; sessionId: string; slackUserId?: string }
export const MAYA: Developer = { developerId: "d".repeat(64), name: "Maya Chen", provider: "slack", sessionId: "s-maya", slackUserId: "U0MAYA001" };
export const OMAR: Developer = { developerId: "e".repeat(64), name: "Omar Diaz", provider: "oidc", sessionId: "s-omar" };

const signer = localSigner();

/**
 * Artifact storage for developer task tests (ruling F5): PutObject keeps the body by key, and
 * GetObject answers it, honoring a `bytes=0-N` range, as `{ Body: { transformToString } }`.
 */
export function memoryS3() {
  const objects = new Map<string, string>();
  const send = vi.fn(async (command: { constructor: { name: string }; input: { Key?: string; Body?: unknown; Range?: string } }) => {
    const key = command.input.Key ?? "";
    if (command.constructor.name === "PutObjectCommand") {
      objects.set(key, String(command.input.Body));
      return {};
    }
    if (command.constructor.name === "GetObjectCommand") {
      const body = objects.get(key);
      if (body === undefined) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
      const range = /^bytes=0-(\d+)$/.exec(command.input.Range ?? "");
      const bytes = Buffer.from(body, "utf8");
      const served = range ? bytes.subarray(0, Number(range[1]) + 1) : bytes;
      return { Body: { transformToString: async (encoding = "utf8") => served.toString(encoding as BufferEncoding) } };
    }
    throw new Error(`memoryS3 does not handle ${command.constructor.name}`);
  });
  return { send, objects };
}

async function bearer(who: Developer): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: DEV_ISSUER, aud: "agentx-developer", sub: who.developerId, amr: who.provider, env: "staging", sid: who.sessionId, iat: now, nbf: now, exp: now + 3600 };
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: (await signer.publicJwk()).kid })).toString("base64url");
  const input = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `Bearer ${input}.${(await signer.sign(Buffer.from(input))).toString("base64url")}`;
}

/** A signed access token for `who`, as an `authorization` header value (Task 16 plants it in a token store). */
export const bearerFor = bearer;

export async function createDeveloperTaskBroker(options: {
  memberLimit?: number;
  organizationLimit?: number;
  /** null: the environment has no Slack team ID. */
  slackTeamId?: string | null;
  channelMembers?: (request: ChannelMembersRequest) => Promise<ChannelMembersResponse>;
  channelInfo?: (request: ChannelInfoRequest) => Promise<ChannelInfoResponse>;
  register?: boolean;
} = {}) {
  const module = await loadSlackBroker() as unknown as { createDeveloperTaskActions: (input: never) => DeveloperTaskActions };
  const channelMembers = vi.fn(options.channelMembers ?? (async (request: ChannelMembersRequest): Promise<ChannelMembersResponse> => ({ ok: true, memberOf: request.slackUserId === MAYA.slackUserId ? request.channelIds.filter((id) => id === SLACK_CHANNEL) : [] })));
  const channelInfo = vi.fn(options.channelInfo ?? (async (request: ChannelInfoRequest): Promise<ChannelInfoResponse> => ({ ok: true, channels: request.channelIds.map((channelId) => ({ channelId, name: "payments-dev", isPrivate: false })) })));
  const developer: DeveloperApiConfiguration = {
    issuer: DEV_ISSUER, env: "staging", methods: { slack: true, oidc: true },
    ...(options.slackTeamId === null ? {} : { slackTeamId: options.slackTeamId ?? SLACK_TEAM }),
    signInTableName: "signin", channelMembers, channelInfo,
    verifyAccessToken: developerTokenVerifier({ issuer: DEV_ISSUER, keys: async () => [await signer.publicJwk()], now: () => Date.now() }),
  };
  const s3 = memoryS3();
  const { db, handler, deleteEc2Session, brokerInput } = createBroker({
    s3,
    ...(options.memberLimit === undefined ? {} : { memberLimit: options.memberLimit }),
    ...(options.organizationLimit === undefined ? {} : { organizationLimit: options.organizationLimit }),
    developer, turnRecordsTableName: "turns",
  });
  const actions = module.createDeveloperTaskActions(brokerInput as never);
  for (const who of [MAYA, OMAR]) {
    db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    db.set({
      pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name,
      ...(who.slackUserId === undefined ? {} : { slackUserId: who.slackUserId }), firstSignInAt: "x", lastSignInAt: "x", revoked: false,
    });
  }
  if (options.register !== false) await registerSlackProject(handler);

  const dev = async (who: Developer, method: string, path: string, body?: unknown) => {
    const response = await handler({
      version: "2.0", rawPath: path.split("?")[0], rawQueryString: path.split("?")[1] ?? "",
      headers: { authorization: await bearer(who) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      requestContext: { requestId: randomUUID(), http: { method } },
    });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  const capability = (operationId: string) => {
    const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0];
    const value = (outbox?.invocation as { callbackCapability?: string } | undefined)?.callbackCapability;
    if (!value) throw new Error(`no outbox item for operation ${operationId}`);
    return value;
  };
  const callback = async (workspaceId: string, operationId: string, action: string, body: unknown) => {
    const response = await call(handler, {
      method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/${action}`,
      headers: { "x-agentx-callback-capability": capability(operationId) }, body,
    });
    if (response.status !== 200) throw new Error(`${action} callback failed: ${JSON.stringify(response.body)}`);
    return response.body;
  };
  return {
    db, handler, actions, s3, brokerInput, deleteEc2Session, channelMembers, channelInfo, dev, callback,
    finish: (workspaceId: string, operationId: string, status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED", detail: { result?: unknown; error?: string } = {}) =>
      callback(workspaceId, operationId, "result", { operationId, status, ...(detail.result === undefined ? {} : { result: detail.result }), ...(detail.error === undefined ? {} : { error: detail.error }) }),
    events: (workspaceId: string, operationId: string, events: Array<{ type: string; payload: unknown }>) =>
      callback(workspaceId, operationId, "events", { events: events.map((event) => ({ ...event, timestamp: new Date().toISOString() })) }),
    artifact: (workspaceId: string, operationId: string, name: string, content: string) =>
      callback(workspaceId, operationId, "artifacts", { name, mediaType: "text/plain", content }),
  };
}

const ADMIN = { subject: "admin-subject", admin: true };

/** Binds another Slack channel of the test team to a project, as `agentx admin slack bind` does. */
export async function bindChannel(handler: Handler, channelId: string, projectName = "payments"): Promise<void> {
  const response = await call(handler, { method: "PUT", path: `/v1/admin/slack/bindings/${SLACK_TEAM}/${channelId}`, user: ADMIN, body: { projectName } });
  if (response.status !== 200) throw new Error(`binding failed: ${JSON.stringify(response.body)}`);
}

export async function unbindChannel(handler: Handler, channelId: string): Promise<void> {
  const response = await call(handler, { method: "DELETE", path: `/v1/admin/slack/bindings/${SLACK_TEAM}/${channelId}`, user: ADMIN });
  if (response.status !== 200) throw new Error(`unbinding failed: ${JSON.stringify(response.body)}`);
}

/** Registers revision `revision` of payments with the given developerTasks, as an administrator (FR-014). */
export async function registerRevision(handler: Handler, revision: number, developerTasks: Record<string, unknown>): Promise<void> {
  const response = await call(handler, {
    method: "POST", path: "/v1/admin/projects", user: ADMIN,
    body: {
      definition: {
        name: "payments", revision,
        repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
        setup: [], readiness: [], orchestratorInstructions: "Delegate work.", developerTasks,
      },
      runtimeBinding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" },
    },
  });
  if (response.status !== 201) throw new Error(`registration failed: ${JSON.stringify(response.body)}`);
}

/** An admin grant (FR-013), so access does not depend on a bound channel. */
export function grantProject(db: FakeDynamoDb, who: Developer, projectName = "payments"): void {
  db.set({ pk: `MEMBER#${who.developerId}`, sk: `PROJECT#${projectName}`, entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName, role: "developer" });
}

/** What the notifier's start message leaves behind (Task 7): the thread on the task, and its record. */
export function markThreadPosted(db: FakeDynamoDb, taskId: string, threadTs = "1695500000.000100"): string {
  const task = db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { share: Record<string, unknown>; shareVersion: number; workspaceId: string; ownerKey: string; developerId: string; developerName: string; project: string };
  const share = { ...task.share, threadTs };
  db.set({ ...task, share, shareVersion: task.shareVersion + 1 });
  const thread = { teamId: String(share.teamId), channelId: String(share.channelId), threadTs };
  db.set({
    ...sharedTaskKey(thread), entityType: "SHARED_TASK", taskId, workspaceId: task.workspaceId, ownerKey: task.ownerKey,
    developerId: task.developerId, developerName: task.developerName, project: task.project, mode: share.mode, sharedAt: share.sharedAt,
  });
  return `${thread.teamId}/${thread.channelId}/${threadTs}`;
}
