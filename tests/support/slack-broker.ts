// A hosted Slack broker harness: a fake DynamoDB, the Slack orchestrator's service identity, and
// optional GitHub MCP, connector type and connector credential dependencies.
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { ConnectorType } from "../../packages/broker/src/aws/connector-types.js";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
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
  deleteEc2Session?: ((workspaceId: string) => Promise<void>) | null;
  connectorTypes?: Record<string, ConnectorType>;
  connectorCredentials?: ConnectorCredentialsConfiguration;
  credentialRegistry?: CredentialRegistry;
  developer?: DeveloperApiConfiguration;
  turnRecordsTableName?: string;
  /** Artifact storage; a bare mock that answers nothing when absent. */
  s3?: { send: (command: never) => Promise<unknown> };
} = {}) {
  if (!loaded) throw new Error("call loadSlackBroker() in a beforeAll before createBroker()");
  const db = new FakeDynamoDb();
  const deleteEc2Session = options.deleteEc2Session === null ? undefined : vi.fn(options.deleteEc2Session ?? (async () => undefined));
  const brokerInput = {
    documentClient: db,
    s3: options.s3 ?? { send: vi.fn() },
    ...(deleteEc2Session ? { deleteEc2Session } : {}),
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
    ...(options.developer ? { developer: options.developer } : {}),
    ...(options.turnRecordsTableName ? { turnRecordsTableName: options.turnRecordsTableName } : {}),
    ...(options.slack === false
      ? {}
      : {
          slack: {
            orchestratorRoleArn,
            memberWorkspaceLimit: options.memberLimit ?? 3,
            organizationWorkspaceLimit: options.organizationLimit ?? 20,
          },
        }),
  };
  const handler = loaded.createAwsBrokerHandler(brokerInput as never);
  return { db, handler, deleteEc2Session, brokerInput };
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

export const SLACK_TEAM = "T0BSHLLUGBD";
export const SLACK_CHANNEL = "C0123456789";
const projectAdministrator = { subject: "admin-subject", admin: true };

/** Registers project "payments" at a revision and, unless told not to, binds the test channel to it. */
export async function registerSlackProject(
  handler: Handler,
  options: { revision?: number; connectors?: unknown[]; models?: unknown; bind?: boolean } = {},
): Promise<void> {
  const revision = options.revision ?? 1;
  const registered = await call(handler, {
    method: "POST",
    path: "/v1/admin/projects",
    user: projectAdministrator,
    body: {
      definition: {
        name: "payments",
        revision,
        repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
        setup: [],
        readiness: [],
        orchestratorInstructions: `Delegate work (revision ${revision}).`,
        ...(options.models ? { models: options.models } : {}),
        ...(options.connectors ? { integrations: { connectors: options.connectors } } : {}),
      },
      runtimeBinding: {
        deploymentMode: "ec2-ebs" as const,
        launchTemplateId: "lt-0123456789abcdef0",
        subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }],
        volumeSizeGiB: 20,
        volumeType: "gp3" as const,
      },
    },
  });
  if (registered.status !== 201) throw new Error(`project registration failed: ${JSON.stringify(registered.body)}`);
  if (options.bind === false) return;
  const bound = await call(handler, {
    method: "PUT",
    path: `/v1/admin/slack/bindings/${SLACK_TEAM}/${SLACK_CHANNEL}`,
    user: projectAdministrator,
    body: { projectName: "payments" },
  });
  if (bound.status !== 200) throw new Error(`channel binding failed: ${JSON.stringify(bound.body)}`);
}

/** A request from the hosted Slack orchestrator, acting for one thread and one member. */
export function serviceCall(handler: Handler, thread: string, slackUser: string, method: string, path: string, body?: unknown) {
  return call(handler, {
    method,
    path,
    service: { principal: orchestratorPrincipal, thread, slackUser },
    ...(body === undefined ? {} : { body }),
  });
}

/** Completes an operation through the worker's terminal-result callback, as the runtime does. */
export async function finishOperation(
  handler: Handler,
  db: FakeDynamoDb,
  workspaceId: string,
  operationId: string,
  status: "SUCCEEDED" | "FAILED",
  result?: unknown,
): Promise<void> {
  const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0];
  const capability = (outbox?.invocation as { callbackCapability?: string } | undefined)?.callbackCapability;
  if (!capability) throw new Error("callback capability is missing");
  const response = await call(handler, {
    method: "POST",
    path: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/result`,
    headers: { "x-agentx-callback-capability": capability },
    body: {
      operationId,
      status,
      ...(result === undefined ? {} : { result }),
      ...(status === "FAILED" ? { error: "clone failed" } : {}),
    },
  });
  if (response.status !== 200) throw new Error(`terminal callback failed: ${JSON.stringify(response.body)}`);
}

/** A GitHub MCP double offering one read tool, list_issues. */
export function fakeGitHubMcp() {
  const invoke = vi.fn(async () => ({ content: [{ type: "text", text: "2 open issues" }] }));
  const credentials = vi.fn(async () => ({ owner: "example", repo: "demo", token: "installation-secret" }));
  const connect = vi.fn(async () => ({
    tools: [{
      name: "list_issues",
      description: "List issues",
      inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" } }, required: ["owner", "repo"] },
    }],
    call: invoke,
    close: async () => undefined,
  }));
  return { githubMcp: { credentials, connect } as unknown as GitHubMcpDependencies, invoke };
}

export const GITHUB_LIST_ISSUES = [
  { name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }] },
];

/** The thread workspace request of a Slack service that opts in to lazy preparation (spec 014). */
export function lazyEnsureWorkspace(handler: Handler, thread: string, slackUser: string, requestId = randomUUID()) {
  return call(handler, {
    method: "POST",
    path: "/v1/service/threads/workspace",
    service: { principal: orchestratorPrincipal, thread, slackUser },
    body: {
      requestId, includeIntegrations: true, includeSettingsRevision: true, includeConnectors: true,
      includeAllConnectorTypes: true, includeRecoverableOperations: true, lazyPreparation: true,
    },
  });
}

/** Asks the broker to prepare this thread's compute, as the lazy worker does (spec 014). */
export function prepareThread(handler: Handler, thread: string, slackUser: string, requestId = randomUUID()) {
  return call(handler, {
    method: "POST",
    path: "/v1/service/threads/workspace/prepare",
    service: { principal: orchestratorPrincipal, thread, slackUser },
    body: { requestId },
  });
}
