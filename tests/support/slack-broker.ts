// A hosted Slack broker harness: a fake DynamoDB, the Slack orchestrator's service identity, and
// optional GitHub MCP, connector type and connector credential dependencies.
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { ConnectorType } from "../../packages/broker/src/aws/connector-types.js";
import type { ConnectorCredentialsConfiguration, CredentialRegistry } from "../../packages/broker/src/aws/credentials.js";
import type { GitHubMcpDependencies } from "../../packages/broker/src/github-mcp.js";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";

export const issuer = "https://identity.example.test";
export const account = "111122223333";
export const orchestratorRoleArn = `arn:aws:iam::${account}:role/AgentXSlackOrchestrator-TaskRole`;
export const orchestratorPrincipal = `arn:aws:sts::${account}:assumed-role/AgentXSlackOrchestrator-TaskRole/ecs-task-1`;

export type Handler = (event: unknown) => Promise<{ statusCode: number; body: string }>;

export interface SlackBrokerModule {
  createAwsBrokerHandler: (dependencies: never) => Handler;
  deleteCapacityProviderWorkspaceSession: (
    client: { send(command: unknown): Promise<unknown> },
    input: { capacityProviderArn: string; runtimeSessionId: string },
  ) => Promise<void>;
}

let loaded: SlackBrokerModule | undefined;

/**
 * The broker module reads its bootstrap environment when it is first imported, so the environment
 * is set before the dynamic import. Call it from a beforeAll before createBroker.
 */
export async function loadSlackBroker(): Promise<SlackBrokerModule> {
  if (loaded) return loaded;
  Object.assign(process.env, {
    AWS_REGION: "us-east-1",
    STATE_TABLE_NAME: "unused",
    ARTIFACT_BUCKET_NAME: "unused",
    OIDC_ISSUER: issuer,
    CALLBACK_SIGNING_KEY: "c".repeat(64),
    GITHUB_APP_PRIVATE_KEY_SECRET_ARN: `arn:aws:secretsmanager:us-east-1:${account}:secret:test`,
    GITHUB_APP_CREDENTIAL_REF: "github-app",
    GITHUB_APP_ACCOUNT: "example",
    GITHUB_APP_ID: "123",
    GITHUB_APP_INSTALLATION_ID: "456",
  });
  loaded = await import("../../packages/broker/src/aws/broker.js") as unknown as SlackBrokerModule;
  return loaded;
}

export function createBroker(options: {
  memberLimit?: number;
  organizationLimit?: number;
  slack?: boolean;
  githubMcp?: GitHubMcpDependencies;
  deleteWorkspaceSession?: () => Promise<void>;
  connectorTypes?: Record<string, ConnectorType>;
  connectorCredentials?: ConnectorCredentialsConfiguration;
  credentialRegistry?: CredentialRegistry;
} = {}) {
  if (!loaded) throw new Error("call loadSlackBroker() in a beforeAll before createBroker()");
  const db = new FakeDynamoDb();
  const deleteWorkspaceSession = vi.fn(options.deleteWorkspaceSession ?? (async () => undefined));
  const handler = loaded.createAwsBrokerHandler({
    documentClient: db,
    s3: { send: vi.fn() },
    stopRuntimeSession: vi.fn(),
    deleteWorkspaceSession,
    tableName: "state",
    artifactBucketName: "artifacts",
    issuer,
    adminClaim: "groups",
    adminValues: ["admins"],
    callbackSigningKey: "c".repeat(64),
    repositoryGrants: new RepositoryGrantService(Buffer.alloc(32, 4), async () => ({ token: "unused" })),
    githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn() },
    codeBuild: { start: vi.fn(), status: vi.fn() },
    ...(options.githubMcp ? { githubMcp: options.githubMcp } : {}),
    ...(options.connectorTypes ? { connectorTypes: options.connectorTypes } : {}),
    ...(options.connectorCredentials ? { connectorCredentials: options.connectorCredentials } : {}),
    ...(options.credentialRegistry ? { credentialRegistry: options.credentialRegistry } : {}),
    ...(options.slack === false
      ? {}
      : {
          slack: {
            orchestratorRoleArn,
            memberWorkspaceLimit: options.memberLimit ?? 3,
            organizationWorkspaceLimit: options.organizationLimit ?? 20,
          },
        }),
  } as never);
  return { db, handler, deleteWorkspaceSession };
}

export interface CallOptions {
  method: string;
  path: string;
  body?: unknown;
  user?: { subject: string; admin?: boolean };
  service?: { principal?: string; thread?: string; slackUser?: string };
  headers?: Record<string, string>;
}

export async function call(handler: Handler, options: CallOptions): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.service?.thread !== undefined) headers["x-agentx-slack-thread"] = options.service.thread;
  if (options.service?.slackUser !== undefined) headers["x-agentx-slack-user"] = options.service.slackUser;
  const authorizer = options.user
    ? { jwt: { claims: { iss: issuer, sub: options.user.subject, groups: options.user.admin ? ["admins"] : [] } } }
    : options.service?.principal
      ? { iam: { userArn: options.service.principal } }
      : undefined;
  const response = await handler({
    version: "2.0",
    rawPath: options.path.split("?")[0],
    rawQueryString: options.path.split("?")[1] ?? "",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    requestContext: { requestId: randomUUID(), http: { method: options.method }, ...(authorizer ? { authorizer } : {}) },
  });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}

export function ensureWorkspace(handler: Handler, thread: string, slackUser: string, requestId = randomUUID()) {
  return call(handler, {
    method: "POST",
    path: "/v1/service/threads/workspace",
    service: { principal: orchestratorPrincipal, thread, slackUser },
    body: { requestId, includeIntegrations: true, includeSettingsRevision: true },
  });
}

export function markReady(db: FakeDynamoDb, workspaceId: string): void {
  const workspace = db.get(`WORKSPACE#${workspaceId}`, "META");
  if (!workspace) throw new Error("workspace record is missing");
  // Mirrors the broker's terminal transition, which removes activeOperationId rather than nulling it.
  workspace.status = "READY";
  delete workspace.activeOperationId;
}
