// An administration-only broker harness: a fake DynamoDB, no Slack, and optional GitHub MCP and
// connector credential dependencies. It mirrors createBroker in slack-control-plane.test.ts.
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { GitHubMcpDependencies } from "../../packages/broker/src/github-mcp.js";
import type { ConnectorCredentialsConfiguration, CredentialRegistry } from "../../packages/broker/src/aws/credentials.js";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";

export const adminIssuer = "https://identity.example.test";
const account = "111122223333";

export type AdminHandler = (event: unknown) => Promise<{ statusCode: number; body: string }>;

interface BrokerModules {
  createAwsBrokerHandler: (dependencies: never) => AdminHandler;
  CredentialRegistry: typeof CredentialRegistry;
}

let modules: Promise<BrokerModules> | undefined;

/**
 * The broker module reads its bootstrap environment when it is first imported, so the environment
 * is set before the dynamic import, once per test file. Safe to call from a beforeAll or a test.
 */
function loadBroker(): Promise<BrokerModules> {
  modules ??= (async () => {
    Object.assign(process.env, {
      AWS_REGION: "us-east-1",
      STATE_TABLE_NAME: "unused",
      ARTIFACT_BUCKET_NAME: "unused",
      OIDC_ISSUER: adminIssuer,
      CALLBACK_SIGNING_KEY: "c".repeat(64),
      GITHUB_APP_PRIVATE_KEY_SECRET_ARN: `arn:aws:secretsmanager:us-east-1:${account}:secret:test`,
      GITHUB_APP_CREDENTIAL_REF: "github-app",
      GITHUB_APP_ACCOUNT: "example",
      GITHUB_APP_ID: "123",
      GITHUB_APP_INSTALLATION_ID: "456",
    });
    const broker = await import("../../packages/broker/src/aws/broker.js") as unknown as Pick<BrokerModules, "createAwsBrokerHandler">;
    const credentials = await import("../../packages/broker/src/aws/credentials.js");
    return { createAwsBrokerHandler: broker.createAwsBrokerHandler, CredentialRegistry: credentials.CredentialRegistry };
  })();
  return modules;
}

export async function createAdminBroker(options: {
  githubMcp?: GitHubMcpDependencies;
  connectorCredentials?: ConnectorCredentialsConfiguration;
} = {}): Promise<{ db: FakeDynamoDb; handler: AdminHandler; registry: CredentialRegistry | undefined }> {
  const { createAwsBrokerHandler, CredentialRegistry: Registry } = await loadBroker();
  const db = new FakeDynamoDb();
  const registry = options.connectorCredentials
    ? new Registry({ ...options.connectorCredentials, documentClient: db as never, tableName: "state" })
    : undefined;
  const handler = createAwsBrokerHandler({
    documentClient: db,
    s3: { send: vi.fn() },
    stopRuntimeSession: vi.fn(),
    deleteWorkspaceSession: vi.fn(async () => undefined),
    tableName: "state",
    artifactBucketName: "artifacts",
    issuer: adminIssuer,
    adminClaim: "groups",
    adminValues: ["admins"],
    callbackSigningKey: "c".repeat(64),
    repositoryGrants: new RepositoryGrantService(Buffer.alloc(32, 4), async () => ({ token: "unused" })),
    githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn() },
    codeBuild: { start: vi.fn(), status: vi.fn() },
    ...(options.githubMcp ? { githubMcp: options.githubMcp } : {}),
    ...(options.connectorCredentials ? { connectorCredentials: options.connectorCredentials } : {}),
    ...(registry ? { credentialRegistry: registry } : {}),
  } as never);
  return { db, handler, registry };
}

/** Calls the OIDC entry point as "admin-subject", an administrator unless `admin` is false. */
export async function adminCall(
  handler: AdminHandler,
  options: { method: string; path: string; body?: unknown; admin?: boolean },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const claims = { iss: adminIssuer, sub: "admin-subject", groups: options.admin === false ? [] : ["admins"] };
  const response = await handler({
    version: "2.0",
    rawPath: options.path.split("?")[0],
    rawQueryString: options.path.split("?")[1] ?? "",
    headers: {},
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    requestContext: { requestId: randomUUID(), http: { method: options.method }, authorizer: { jwt: { claims } } },
  });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}
